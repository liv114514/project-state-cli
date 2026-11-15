from __future__ import annotations

"""Read-only Windows ACL gate for explicitly selected private state parents."""

import ctypes
import os
from ctypes import wintypes
from pathlib import Path

from project_state.contracts.errors import ProjectStateError


class _AclSizeInformation(ctypes.Structure):
    _fields_ = [("AceCount", wintypes.DWORD),
                ("AclBytesInUse", wintypes.DWORD),
                ("AclBytesFree", wintypes.DWORD)]


class _AceHeader(ctypes.Structure):
    _fields_ = [("AceType", wintypes.BYTE), ("AceFlags", wintypes.BYTE),
                ("AceSize", wintypes.WORD)]


def assert_private_windows_acl(path: Path) -> None:
    """Require current-user ownership and a narrow allow-list without changing ACLs.

    SYSTEM and local Administrators remain allowed for normal Windows servicing.
    The active process AppContainer SID is allowed when present (for packaged
    desktop hosts), but arbitrary groups, Authenticated Users and Users are not.
    Unknown ACE types fail closed because their effective access is not decoded.
    """
    if os.name != "nt":
        raise ProjectStateError("ELOCATION_ACL_UNSUPPORTED", "explicit private state locations are not enabled on this platform", 2)
    try:
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        aclapi = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi.OpenProcessToken.restype = wintypes.BOOL
        advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                               wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        advapi.GetTokenInformation.restype = wintypes.BOOL
        advapi.ConvertStringSidToSidW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
        advapi.ConvertStringSidToSidW.restype = wintypes.BOOL
        advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
        advapi.GetSecurityDescriptorDacl.restype = wintypes.BOOL
        advapi.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int]
        advapi.GetAclInformation.restype = wintypes.BOOL
        advapi.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
        advapi.GetAce.restype = wintypes.BOOL
        owner = ctypes.c_void_p()
        dacl = ctypes.c_void_p()
        descriptor = ctypes.c_void_p()
        get_named = aclapi.GetNamedSecurityInfoW
        get_named.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
                              ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                              ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                              ctypes.POINTER(ctypes.c_void_p)]
        get_named.restype = wintypes.DWORD
        error = get_named(str(path), 1, 0x1 | 0x4, ctypes.byref(owner), None,
                          ctypes.byref(dacl), None, ctypes.byref(descriptor))
        if error:
            raise OSError(error, "GetNamedSecurityInfoW failed")
        if not descriptor.value or not owner.value:
            raise ValueError("owner security descriptor unavailable")

        token = wintypes.HANDLE()
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            raise OSError(ctypes.get_last_error(), "OpenProcessToken failed")
        try:
            needed = wintypes.DWORD()
            advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
            if not needed.value:
                raise OSError(ctypes.get_last_error(), "GetTokenInformation size failed")
            token_buffer = ctypes.create_string_buffer(needed.value)
            if not advapi.GetTokenInformation(token, 1, token_buffer, needed, ctypes.byref(needed)):
                raise OSError(ctypes.get_last_error(), "GetTokenInformation failed")
            current_sid = ctypes.cast(token_buffer, ctypes.POINTER(ctypes.c_void_p))[0]

            sid_buffers: list[ctypes.c_void_p] = []
            accepted = [current_sid]
            for sid_text in ("S-1-5-18", "S-1-5-32-544"):
                sid = ctypes.c_void_p()
                if not advapi.ConvertStringSidToSidW(sid_text, ctypes.byref(sid)):
                    raise OSError(ctypes.get_last_error(), "ConvertStringSidToSidW failed")
                sid_buffers.append(sid)
                accepted.append(sid)
            # A packaged desktop host may use the process AppContainer SID.
            # TokenAppContainerSid returns TOKEN_APPCONTAINER_INFORMATION,
            # whose first member is the documented SID pointer. Do not treat
            # unrelated token-information classes as package/group SID data.
            token_buffers = []
            for token_class in (31,):  # TokenAppContainerSid
                app_needed = wintypes.DWORD()
                advapi.GetTokenInformation(token, token_class, None, 0, ctypes.byref(app_needed))
                if app_needed.value:
                    app_buffer = ctypes.create_string_buffer(app_needed.value)
                    token_buffers.append(app_buffer)
                    if advapi.GetTokenInformation(token, token_class, app_buffer, app_needed, ctypes.byref(app_needed)):
                        app_sid = ctypes.cast(app_buffer, ctypes.POINTER(ctypes.c_void_p))[0]
                        if app_sid:
                            accepted.append(app_sid)

            equal_sid = advapi.EqualSid
            equal_sid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            equal_sid.restype = wintypes.BOOL
            if not equal_sid(owner, current_sid):
                raise ValueError("explicit state parent is not owned by the current user")

            present = wintypes.BOOL()
            defaulted = wintypes.BOOL()
            if not advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present),
                                                    ctypes.byref(dacl), ctypes.byref(defaulted)):
                raise OSError(ctypes.get_last_error(), "GetSecurityDescriptorDacl failed")
            if not present.value or not dacl.value:
                raise ValueError("explicit state parent has a null or absent DACL")

            size = _AclSizeInformation()
            if not advapi.GetAclInformation(dacl, ctypes.byref(size), ctypes.sizeof(size), 2):
                raise OSError(ctypes.get_last_error(), "GetAclInformation failed")
            for index in range(size.AceCount):
                ace = ctypes.c_void_p()
                if not advapi.GetAce(dacl, index, ctypes.byref(ace)):
                    raise OSError(ctypes.get_last_error(), "GetAce failed")
                header = ctypes.cast(ace, ctypes.POINTER(_AceHeader)).contents
                if header.AceType == 1:  # ACCESS_DENIED_ACE_TYPE cannot grant access.
                    continue
                if header.AceType != 0 or header.AceSize < 12:  # ACCESS_ALLOWED_ACE_TYPE only.
                    raise ValueError("explicit state parent contains an unsupported access ACE")
                sid_address = ace.value + 8
                if not any(equal_sid(ctypes.c_void_p(sid_address), allowed) for allowed in accepted):
                    raise ValueError("explicit state parent grants access outside the private owner set")
        finally:
            kernel.CloseHandle(token)
            for sid in locals().get("sid_buffers", []):
                kernel.LocalFree(sid)
            if descriptor.value:
                kernel.LocalFree(descriptor)
    except ProjectStateError:
        raise
    except Exception as exc:
        raise ProjectStateError("ELOCATION_ACL", "selected state parent is not provably private; choose a user-owned restricted directory; permissions were not changed", 2) from exc
