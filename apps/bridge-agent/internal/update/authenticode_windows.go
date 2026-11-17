//go:build windows

package update

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	crypt32          = windows.NewLazySystemDLL("crypt32.dll")
	procMsgGetParam  = crypt32.NewProc("CryptMsgGetParam")
	procMsgClose     = crypt32.NewProc("CryptMsgClose")
	cmsgSignerCertID = uintptr(7) // CMSG_SIGNER_CERT_INFO_PARAM
)

type winAuth struct{}

// NewAuthenticode verifies with WinVerifyTrustEx (WINTRUST_ACTION_GENERIC_VERIFY_V2) and reads the signer subject name from the file's
// embedded PKCS#7 signature. Revocation checking is off (shop-floor PCs are often offline). The signature check and the name lookup read
// the file twice; the launcher additionally pins agent.exe to the hash in the verified zip (verifyStaged).
func NewAuthenticode() Authenticode { return winAuth{} }

func (winAuth) Publisher(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	if err := winVerify(p); err != nil {
		return "", fmt.Errorf("WinVerifyTrustEx: %w", err)
	}
	return signerName(p)
}

func winVerify(p *uint16) error {
	fi := windows.WinTrustFileInfo{Size: uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})), FilePath: p}
	d := windows.WinTrustData{
		Size:                            uint32(unsafe.Sizeof(windows.WinTrustData{})),
		UIChoice:                        windows.WTD_UI_NONE,
		RevocationChecks:                windows.WTD_REVOKE_NONE,
		UnionChoice:                     windows.WTD_CHOICE_FILE,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&fi),
		StateAction:                     windows.WTD_STATEACTION_VERIFY,
		ProvFlags:                       windows.WTD_REVOCATION_CHECK_NONE,
	}
	hwnd := windows.HWND(^uintptr(0)) // INVALID_HANDLE_VALUE: no UI
	err := windows.WinVerifyTrustEx(hwnd, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &d)
	d.StateAction = windows.WTD_STATEACTION_CLOSE
	_ = windows.WinVerifyTrustEx(hwnd, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &d)
	runtime.KeepAlive(&fi)
	return err
}

func signerName(p *uint16) (string, error) {
	var enc, content, format uint32
	var store, msg windows.Handle
	if err := windows.CryptQueryObject(windows.CERT_QUERY_OBJECT_FILE, unsafe.Pointer(p),
		windows.CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, windows.CERT_QUERY_FORMAT_FLAG_BINARY, 0,
		&enc, &content, &format, &store, &msg, nil); err != nil {
		return "", fmt.Errorf("CryptQueryObject: %w", err)
	}
	defer windows.CertCloseStore(store, 0)
	defer procMsgClose.Call(uintptr(msg))

	var n uint32
	if r, _, e := procMsgGetParam.Call(uintptr(msg), cmsgSignerCertID, 0, 0, uintptr(unsafe.Pointer(&n))); r == 0 || n == 0 {
		return "", fmt.Errorf("CryptMsgGetParam: %v", e)
	}
	info := make([]byte, n)
	if r, _, e := procMsgGetParam.Call(uintptr(msg), cmsgSignerCertID, 0, uintptr(unsafe.Pointer(&info[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return "", fmt.Errorf("CryptMsgGetParam: %v", e)
	}
	cert, err := windows.CertFindCertificateInStore(store, enc, 0, windows.CERT_FIND_SUBJECT_CERT, unsafe.Pointer(&info[0]), nil)
	if err != nil {
		return "", fmt.Errorf("signer certificate not found: %w", err)
	}
	defer windows.CertFreeCertificateContext(cert)
	chars := windows.CertGetNameString(cert, windows.CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nil, nil, 0)
	if chars <= 1 {
		return "", errors.New("signer certificate has no subject name")
	}
	name := make([]uint16, chars)
	windows.CertGetNameString(cert, windows.CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nil, &name[0], chars)
	return windows.UTF16ToString(name), nil
}
