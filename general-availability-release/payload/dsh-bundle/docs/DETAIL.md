# Windows computer use

Adds a local MCP server to DeepSeek Harness: the agent sees the screen through screenshots and acts
through real Windows keyboard and mouse input. The server runs as a stdio child process of DSH — it
opens no network port and needs no service, daemon, or `npm install`.

All 27 tools appear as `mcp__computeruse__<name>`:

- Observe: `screenshot`, `zoom`, `list_windows`, `get_window`, `cursor_position`
- Windows: `open_application`, `activate_window`, `switch_display`
- Mouse: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`,
  `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`
- Keyboard: `type`, `key`, `hold_key`
- Clipboard: `read_clipboard`, `write_clipboard`
- Orchestration: `computer_batch`, `wait`, `request_access`, `list_granted_applications`

Environment diagnostics (monitors, integrity level, elevation helper, screenshot anchor age, limits)
come from `list_granted_applications` with `include_desktop: true`; there is no separate desktop-info
tool, so the surface stays at the upstream 27.

Coordinates are pixels in the most recent screenshot. A click whose target window moved since that
screenshot is refused instead of landing on a stale offset. After `open_application` the session is
window-bound: coordinates are window-relative, the window is activated first, and a green frame is
drawn just outside it so a human can see which window is being driven.

Clicks use posted window messages when the bound window's framework accepts them (classic USER32 or
an unrecognized class name), and real input otherwise (Chromium, WPF, WinUI, WinForms, JavaFX,
Flutter, Unreal, Tk, self-drawn). A truncated control tree is classified as unknown and uses real
input. The policy flag `backgroundInput` gates the posted channel; `input_channel: "auto" | "message" | "real"`
overrides it per click. The `open_application` reply reports the classification.

## Policy

The policy file is the only authority; the model cannot grant itself an application:

`%USERPROFILE%\.computer-use-win\policy.json`

Tiers are `none` < `read` < `click` < `full`, decided per application, with `unlisted` covering
everything not listed. The shipped default is the `standard` preset: observation of anything, but
clicking and typing require an explicit entry, for example
`{"app": "notepad.exe", "tier": "full"}`. Editing the file takes effect on the next tool call — the
policy is re-read when its modification time changes, so no restart is needed. A broken edit keeps
the previous policy and logs why.

The file is never written by DSH or by the agent. `request_access` only reports what the current
policy grants and how to grant more; it cannot change the policy.

## Safety

- A physical **Escape** press aborts the running action or batch. Injected Escape is ignored, so the
  agent's own `key` call is never mistaken for a human abort.
- While a `click`-tier application is the input target, the real clipboard is stashed and cleared so
  its Paste button cannot inject content the user or the agent put there. The original clipboard is
  restored afterwards.
- Elevated (Administrator) windows require consent: the helper process starts through a UAC prompt,
  only for an allowed target above the server's own integrity level, and only when the policy allows
  `elevation`. UAC's secure-desktop prompt itself is never automated.
- Session-manager and security-critical processes are refused regardless of policy.

## Limits

- Requires a logged-in interactive desktop session; a locked, disconnected, or service session is
  unavailable.
- Only one agent may drive input at a time; a second server instance reports `lock_held`.
- Elevation stops at Administrator. `SYSTEM` and `TrustedInstaller` targets are out of scope.
- Windows may refuse a background process's attempt to take the foreground
  (`foreground_required`); clicking the window once and retrying resolves it.

## Files

The server and this bundle are installed under `%LOCALAPPDATA%\computer-use-win`. Policies, the
control lock, and screenshots saved with `save_to_disk` live under `%USERPROFILE%\.computer-use-win`.
Uninstall with the release's `uninstall.ps1`, which refuses while a DSH profile still references the
bundle.
