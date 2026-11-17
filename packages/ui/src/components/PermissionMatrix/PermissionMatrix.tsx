import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { StatusChip } from '../StatusChip/StatusChip';

export interface PermissionModule {
  id: string;
  label: string;
}

export interface PermissionDef {
  code: string;
  moduleId: string;
  resource: string;
  isPrivileged?: boolean;
  /** Default true. */
  isAssignable?: boolean;
  unassignableReason?: string;
}

export interface PermissionMatrixProps {
  label: string;
  modules: readonly PermissionModule[];
  permissions: readonly PermissionDef[];
  value: readonly string[];
  onChange: (codes: string[]) => void;
  isReadOnly?: boolean;
  'data-testid'?: string;
}

/**
 * Role editor matrix (C2 04-UI-UX:57): rows = modules, columns = resources, one checkbox per code.
 * One tab stop; arrows move (Left/Right through codes, Up/Down to the same column in the next module); Space toggles.
 * Codes the matrix cannot assign are disabled and pass through `value` untouched.
 */
export function PermissionMatrix({ label, modules, permissions, value, onChange, isReadOnly = false, ...rest }: PermissionMatrixProps) {
  const id = useId();
  const resources = [...new Set(permissions.map((p) => p.resource))];
  const cell = (m: string, res: string) => permissions.filter((p) => p.moduleId === m && p.resource === res);
  const canToggle = (p: PermissionDef) => !isReadOnly && p.isAssignable !== false;
  // navigable codes in DOM order with their (row, column) position
  const nav = modules.flatMap((m, ri) => resources.flatMap((res, ci) => cell(m.id, res).filter(canToggle).map((p) => ({ code: p.code, ri, ci }))));
  const [activeCode, setActive] = useState<string | undefined>(undefined);
  const current = nav.find((n) => n.code === activeCode) ?? nav[0];
  const boxes = useRef(new Map<string, HTMLInputElement>());

  const go = (code: string | undefined) => {
    if (!code) return;
    setActive(code);
    boxes.current.get(code)?.focus();
  };
  const onKey = (e: KeyboardEvent, code: string) => {
    const i = nav.findIndex((n) => n.code === code);
    const at = nav[i];
    if (!at) return;
    let to: string | undefined;
    if (e.key === 'ArrowRight') to = nav[i + 1]?.code;
    else if (e.key === 'ArrowLeft') to = nav[i - 1]?.code;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = e.key === 'ArrowDown' ? nav.filter((n) => n.ri > at.ri) : nav.filter((n) => n.ri < at.ri).reverse();
      const row = rows[0]?.ri;
      to = (rows.find((n) => n.ri === row && n.ci === at.ci) ?? rows.find((n) => n.ri === row))?.code;
    } else if (e.key === 'Home') to = nav[0]?.code;
    else if (e.key === 'End') to = nav[nav.length - 1]?.code;
    else return;
    e.preventDefault();
    go(to);
  };
  const toggle = (code: string, on: boolean) => onChange(on ? [...value.filter((c) => c !== code), code] : value.filter((c) => c !== code));

  return (
    <table role="grid" aria-label={label} className="lims-table lims-permmatrix" {...(isReadOnly ? { 'aria-readonly': true } : {})} {...rest}>
      <thead>
        <tr role="row">
          <th role="columnheader" scope="col">
            Module
          </th>
          {resources.map((res) => (
            <th key={res} role="columnheader" scope="col">
              {res}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {modules.map((m) => (
          <tr key={m.id} role="row">
            <th role="rowheader" scope="row">
              {m.label}
            </th>
            {resources.map((res) => (
              <td key={res} role="gridcell">
                {cell(m.id, res).map((p) => {
                  const enabled = canToggle(p);
                  const hintId = `${id}-${p.code}-why`;
                  return (
                    <div key={p.code} className="lims-perm">
                      <label className="lims-check">
                        <input
                          ref={(el) => {
                            if (el) boxes.current.set(p.code, el);
                            else boxes.current.delete(p.code);
                          }}
                          type="checkbox"
                          checked={value.includes(p.code)}
                          disabled={!enabled}
                          tabIndex={enabled && current?.code === p.code ? 0 : -1}
                          {...(!enabled && p.unassignableReason ? { 'aria-describedby': hintId } : {})}
                          onFocus={() => enabled && setActive(p.code)}
                          onKeyDown={(e) => onKey(e, p.code)}
                          onChange={(e) => enabled && toggle(p.code, e.target.checked)}
                        />
                        <span className="lims-mono">{p.code}</span>
                      </label>
                      {/* tone + icon + word (LD-140) */}
                      {p.isPrivileged ? <StatusChip kind="generic" status="privileged" tone="warning" label="Privileged" size="sm" /> : null}
                      {!enabled && p.unassignableReason ? (
                        <span id={hintId} className="lims-description">
                          {p.unassignableReason}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
