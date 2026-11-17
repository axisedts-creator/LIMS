-- scrub.lua: Fluent Bit Lua filter, runs on every record before it leaves the host
-- (02-TRD s10.1, 02-CONVENTIONS s9.2, REQ-SEC-098, AC-18.4). Lua 5.1 / LuaJIT compatible.
--
-- 1. Key denylist: case-insensitive SUBSTRINGS of the key, at any nesting depth. The value
--    (scalar or table) is replaced by "[REDACTED]"; the key name stays so the field is visible.
-- 2. Value scrubbers on every string: Nepal-style phone numbers, `Bearer <token>`, JWT (eyJ...).
-- 3. AC-18.4 defence in depth: under URL-ish keys the `?...` part is cut; raw query-string keys
--    are replaced entirely.
-- Allowed fields (UUIDs, IPs, ISO timestamps, request ids, fiscal numbers, error codes, counts,
-- durations) are left intact. Pure function: no files, processes or network. Never raises.

local REDACTED = "[REDACTED]"
local PHONE = "[PHONE]"
local MAX_DEPTH = 32

local DENY = {
  -- 9.2 direct identifiers
  "name", "phone", "email", "address", "dob", "birth", "citizenship", "national_id", "photo",
  -- lab-linked identifiers
  "registration_no", "barcode", "lab_no", "accession",
  -- health data
  "result", "value", "diagnos", "interpretation", "comment", "history",
  -- credentials
  "password", "passwd", "otp", "token", "jwt", "cookie", "secret", "signature", "authorization",
  "api_key", "apikey", "refresh",
  -- financial (restricted)
  "card", "wallet",
}

-- keys whose string value is a URL or path: cut at the first "?"
local URL_KEYS = { ["uri"] = true, ["url"] = true, ["path"] = true, ["request_uri"] = true }
-- keys that hold a raw query string: dropped value
local QUERY_KEYS = { ["query"] = true, ["query_string"] = true, ["args"] = true }

local function key_is_sensitive(lkey)
  for i = 1, #DENY do
    if string.find(lkey, DENY[i], 1, true) then return true end
  end
  return false
end

local function is_alnum_at(s, i)
  if i < 1 then return false end
  return string.find(string.sub(s, i, i), "^%w$") ~= nil
end

-- Nepal-style mobile: 10 digits starting with 9, single separators (space - .) allowed between
-- digits, optional +977 / (977) / 977 prefix which is removed together with the number.
local function scrub_phones(s)
  if not string.find(s, "9", 1, true) then return s, false end
  local out, pos, n, changed = {}, 1, #s, false
  local i = 1
  while true do
    local a = string.find(s, "9", i, true)
    if not a then break end
    local ok = false
    local last = a
    local prev_ok = not is_alnum_at(s, a - 1)
    local prefix_start = a
    if not prev_ok and string.sub(s, a - 3, a - 1) == "977" and not is_alnum_at(s, a - 4) then
      prev_ok = true
      prefix_start = a - 3
    end
    if prev_ok then
      local count, j = 1, a + 1
      while count < 10 and j <= n do
        local c = string.sub(s, j, j)
        if string.find(c, "^%d$") then
          count = count + 1
          last = j
          j = j + 1
        elseif (c == " " or c == "-" or c == ".") and string.find(string.sub(s, j + 1, j + 1), "^%d$") then
          j = j + 1
        else
          break
        end
      end
      -- trailing char must not be alnum: keeps UUIDs intact (02-CONVENTIONS s9.2)
      if count == 10 and not is_alnum_at(s, last + 1) then
        ok = true
      end
    end
    if ok then
      -- swallow a directly preceding +977 / (977) / 977 prefix
      local head = string.sub(s, pos, prefix_start - 1)
      local pre = string.match(head, "%+?%(?977%)?[ %-%.]*$")
      if pre then head = string.sub(head, 1, #head - #pre) end
      if prefix_start < a and string.sub(head, -1) == "+" then head = string.sub(head, 1, #head - 1) end
      out[#out + 1] = head
      out[#out + 1] = PHONE
      pos = last + 1
      i = last + 1
      changed = true
    else
      i = a + 1
    end
  end
  if not changed then return s, false end
  out[#out + 1] = string.sub(s, pos)
  return table.concat(out), true
end

local function scrub_string(s)
  local changed = false
  local r, c
  r, c = string.gsub(s, "[Bb][Ee][Aa][Rr][Ee][Rr]%s+[%w%-%._~%+/]+=*", "Bearer " .. REDACTED)
  if c > 0 then s = r; changed = true end
  r, c = string.gsub(s, "eyJ[%w_%-]*%.[%w_%-]+%.[%w_%-]*", REDACTED)
  if c > 0 then s = r; changed = true end
  r, c = string.gsub(s, "eyJ[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]+", REDACTED)
  if c > 0 then s = r; changed = true end
  local p, pc = scrub_phones(s)
  if pc then s = p; changed = true end
  return s, changed
end

local function cut_query(s)
  local q = string.find(s, "?", 1, true)
  if q then return string.sub(s, 1, q - 1), true end
  return s, false
end

local scrub_table

local function scrub_value(lkey, v, depth)
  local t = type(v)
  if lkey and key_is_sensitive(lkey) then
    return REDACTED, true
  end
  if t == "string" then
    local changed = false
    if lkey and QUERY_KEYS[lkey] then return REDACTED, true end
    if lkey and URL_KEYS[lkey] then
      local cut, c = cut_query(v)
      if c then v = cut; changed = true end
    end
    local r, c2 = scrub_string(v)
    return r, changed or c2
  elseif t == "table" then
    return scrub_table(v, depth + 1)
  end
  return v, false
end

scrub_table = function(tbl, depth)
  if depth > MAX_DEPTH then return REDACTED, true end
  local out, changed = {}, false
  for k, v in pairs(tbl) do
    local nk, lkey = k, nil
    if type(k) == "string" then
      lkey = string.lower(k)
      local sk, kc = scrub_string(k)
      if kc then nk = sk; changed = true end
    end
    local nv, c = scrub_value(lkey, v, depth)
    if c then changed = true end
    out[nk] = nv
  end
  return out, changed
end

function cb_filter(tag, timestamp, record)
  local ok, out, changed = pcall(scrub_table, record, 0)
  if not ok then
    -- never ship a record we could not scrub
    return 1, timestamp, { scrub_error = "record dropped to a stub: scrub failed" }
  end
  if changed then
    return 1, timestamp, out
  end
  return 0, timestamp, record
end
