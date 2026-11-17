//go:build !windows

package svc

import "errors"

var errNotWindows = errors.New("svc: the Windows service platform is only available on Windows")

type unsupportedPlatform struct{}

// NewWindowsPlatform on a non-Windows build returns a platform whose every call fails, so the packages still compile for CI on Linux.
func NewWindowsPlatform(Layout, string) Platform { return unsupportedPlatform{} }

// ApplyACL needs the Windows security API.
func ApplyACL(string, []ACE) error { return errNotWindows }

func (unsupportedPlatform) OSVersion() (OSVersion, error)       { return OSVersion{}, errNotWindows }
func (unsupportedPlatform) IsElevated() bool                    { return false }
func (unsupportedPlatform) PrepareFolders(Layout, string) error { return errNotWindows }
func (unsupportedPlatform) RegisterService(ServiceConfig) error { return errNotWindows }
func (unsupportedPlatform) StartService() error                 { return errNotWindows }
func (unsupportedPlatform) StopService() error                  { return errNotWindows }
func (unsupportedPlatform) RemoveService() error                { return errNotWindows }
func (unsupportedPlatform) AddFirewallRule(string) error        { return errNotWindows }
func (unsupportedPlatform) RemoveFirewallRule() error           { return errNotWindows }
func (unsupportedPlatform) SendControl(uint32) error            { return errNotWindows }
