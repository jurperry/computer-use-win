// Model-facing tool definitions.
//
// Names and argument shapes follow the established computer-use tool set so that models already
// trained on it (Claude, and anything imitating it) behave predictably — with one deliberate
// deviation: environment diagnostics are folded into list_granted_applications instead of a
// separate desktop_info tool, so the Windows surface is the upstream 27 tools, not 28.
// Descriptions are the only documentation the model gets, so they state the coordinate contract
// explicitly and never expose two conventions at once.

const COORD_DESC = {
  pixels: {
    x: 'Horizontal pixel position read directly from the most recent screenshot image, measured from its left edge. The server handles all scaling.',
    y: 'Vertical pixel position read directly from the most recent screenshot image, measured from its top edge. The server handles all scaling.',
  },
  normalized_0_100: {
    x: 'Horizontal position as a percentage of the captured surface width, 0.0-100.0 (0 = left edge, 100 = right edge).',
    y: 'Vertical position as a percentage of the captured surface height, 0.0-100.0 (0 = top edge, 100 = bottom edge).',
  },
}

const GATE_DESC =
  'The effective target window and its policy tier must allow the action. Windows checks the bound window, or the real window under the point / the foreground window for global input. Rejected actions return an error before any input is sent.'

export const MAX_TYPE_TEXT_LENGTH = 100_000
export const MAX_BATCH_ACTIONS = 100

const BATCH_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'key', 'type', 'mouse_move', 'left_click', 'left_click_drag', 'right_click', 'middle_click',
        'double_click', 'triple_click', 'scroll', 'hold_key', 'screenshot', 'cursor_position',
        'left_mouse_down', 'left_mouse_up', 'wait',
      ],
      description: 'The action to perform.',
    },
    coordinate: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: '(x, y) for click / mouse_move / scroll / left_click_drag end point.',
    },
    start_coordinate: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: '(x, y) drag start — left_click_drag only. Omit to drag from the current cursor.',
    },
    text: {
      type: 'string',
      maxLength: MAX_TYPE_TEXT_LENGTH,
      description: 'For type: the text. For key/hold_key: the chord string. For click/scroll: modifier keys to hold.',
    },
    scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    scroll_amount: { type: 'integer', minimum: 0, maximum: 100 },
    duration: { type: 'number', description: 'Seconds (0-100). For hold_key / wait.' },
    repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'For key: repeat count.' },
    input_channel: {
      type: 'string',
      enum: ['auto', 'message', 'real'],
      description: 'For left_click / right_click / middle_click: transport override, same semantics as the click tools.',
    },
  },
  required: ['action'],
}

/**
 * @param {{coordinateMode: 'pixels'|'normalized_0_100', preset: string, policySource: string, flags: Record<string, boolean>, boundWindow?: any}} caps
 */
export function buildTools(caps) {
  const coord = COORD_DESC[caps.coordinateMode] || COORD_DESC.pixels
  const coordinateTuple = {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    description: `(x, y): ${coord.x}`,
  }
  const modifierText = {
    type: 'string',
    description: 'Modifier keys to hold during the click (e.g. "shift", "ctrl+shift"). Same syntax as the key tool.',
  }
  const inputChannel = {
    type: 'string',
    enum: ['auto', 'message', 'real'],
    description:
      'Transport for this click. "auto" (default) posts window messages when the bound window\'s framework accepts them and the backgroundInput flag is on, otherwise it uses real cursor input. ' +
      '"message" forces posted messages (refused for Chromium/WPF/WinUI/WinForms/JavaFX/Flutter/Unreal/Tk/self-drawn windows, multi-clicks, modified clicks and points outside the client area). ' +
      '"real" forces cursor + SendInput. Outside window-bound mode input is always real.',
  }

  return [
    {
      name: 'request_access',
      description:
        'Declare which applications this session intends to control and learn what the local policy allows. Call it before other tools when you are unsure about permissions. ' +
        'Grants are declarative: the policy file configured by the human is the authority, so this never widens permissions — it reports them, and returns the exact file to edit for anything denied. ' +
        'Returns granted apps with their tier, denied apps with the reason, and the effective clipboard / system-key flags.',
      inputSchema: {
        type: 'object',
        properties: {
          apps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Application names, executable names, or paths, e.g. ["notepad", "chrome.exe", "C:\\\\Tools\\\\app.exe"]. Matched case-insensitively against running windows.',
          },
          reason: { type: 'string', description: 'One sentence describing the task. Recorded in the reply for auditability.' },
          clipboardRead: { type: 'boolean', description: 'Also report whether clipboard reading is allowed.' },
          clipboardWrite: { type: 'boolean', description: 'Also report whether clipboard writing is allowed.' },
          systemKeyCombos: { type: 'boolean', description: 'Also report whether system-level key combos are allowed.' },
        },
        required: ['apps', 'reason'],
      },
    },
    {
      name: 'list_granted_applications',
      description:
        'Show the active policy (preset, file, allowed apps, deny list, flags), the coordinate mode, the bound window and the input channel it uses. No side effects. ' +
        'Set include_desktop to also get the environment report (monitors, integrity, elevation helper, capture mode, anchor age, limits, statistics) — that is the first call to make when something behaves unexpectedly.',
      inputSchema: {
        type: 'object',
        properties: {
          include_desktop: {
            type: 'boolean',
            description: 'Also return the desktop/environment diagnostics block (session, monitors, elevation, anchor age, limits, stats). Default false.',
          },
        },
        required: [],
      },
    },
    {
      name: 'screenshot',
      description:
        'Capture the current target: the bound application window if one is bound (open_application), otherwise the selected display. Returns a JPEG plus geometry. ' +
        'Click and type coordinates always refer to the most recent screenshot. Take a new screenshot after any action whose effect you need to verify, and before clicking anything new.',
      inputSchema: {
        type: 'object',
        properties: {
          save_to_disk: {
            type: 'boolean',
            description: 'Also write the JPEG to a file and return its path, for attaching to a message for the user. Not needed just to look at the screen.',
          },
        },
        required: [],
      },
    },
    {
      name: 'zoom',
      description:
        'Capture a higher-resolution image of a region of the last screenshot, for reading small text or fine UI details. ' +
        `The region is given in the coordinate space of that screenshot: ${coord.x} ` +
        'IMPORTANT: zoom is read-only. Coordinates in later click calls still refer to the full screenshot, never to the zoomed image.',
      inputSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'array',
            items: { type: 'number' },
            minItems: 4,
            maxItems: 4,
            description: '(x0, y0, x1, y1) rectangle in the last full screenshot: x0,y0 = top-left, x1,y1 = bottom-right.',
          },
          save_to_disk: { type: 'boolean', description: 'Also write the zoomed JPEG to a file and return its path.' },
        },
        required: ['region'],
      },
    },
    {
      name: 'open_application',
      description:
        'Bind an application window and bring it to the front, launching it if it is not running. Must be allowed by the policy. ' +
        'Binding switches coordinates to window-local space, so always take a screenshot afterwards. If a matching window is already running it is bound as-is and the reply says so. ' +
        'The reply classifies the window framework and reports which input channel later clicks will use.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Executable name ("notepad.exe"), process name ("notepad"), display/title text, or a full path.' },
          launch: { type: 'boolean', description: 'Launch it when no matching window exists. Default true; requires the launchApps policy flag.' },
        },
        required: ['app'],
      },
    },
    {
      name: 'activate_window',
      description: 'Bring an existing window to the foreground without binding it. Useful before reading or when a dialog lost focus.',
      inputSchema: {
        type: 'object',
        properties: { hwnd: { type: 'integer', description: 'Window handle from list_windows / get_window.' } },
        required: ['hwnd'],
      },
    },
    {
      name: 'switch_display',
      description:
        'Leave window-bound mode and capture a whole display with global input coordinates. Use this for desktop-wide work. ' +
        'Pass "auto" for the primary display, a monitor id, or part of a monitor name. Previous image coordinates become invalid — always screenshot after switching.',
      inputSchema: {
        type: 'object',
        properties: {
          display: { type: 'string', description: '"auto", a monitor id ("0", "1"), or part of the device name (e.g. "DISPLAY2").' },
        },
        required: ['display'],
      },
    },
    {
      name: 'list_windows',
      description:
        'List visible top-level windows with title, process, executable, DPI awareness, integrity level and the policy tier each one has. No window rectangles: coordinates always come from the latest screenshot. ' +
        'Use this to find a target instead of guessing, then bind it with open_application or act on it with coordinates after a screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          visibleOnly: { type: 'boolean', description: 'Only windows that are currently visible. Default true.' },
          limit: { type: 'integer', description: 'Maximum windows to return (1-400). Default 80.' },
        },
        required: [],
      },
    },
    {
      name: 'get_window',
      description: 'Detailed information for one window handle: identity, DPI awareness, integrity level, owning process, root window and policy verdict. Size is diagnostic only; there are no coordinates to compute from.',
      inputSchema: {
        type: 'object',
        properties: { hwnd: { type: 'integer', description: 'Window handle.' } },
        required: ['hwnd'],
      },
    },
    {
      name: 'left_click',
      description: `Left-click at the given coordinates. ${GATE_DESC} In window-bound mode the transport is selected from the window's framework; the reply names it.`,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordinateTuple,
          text: modifierText,
          input_channel: inputChannel,
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'double_click',
      description: `Double-click at the given coordinates. Selects a word in most text editors. Always uses real input (the OS click counter cannot be driven by posted messages). ${GATE_DESC}`,
      inputSchema: {
        type: 'object',
        properties: { coordinate: coordinateTuple, text: modifierText },
        required: ['coordinate'],
      },
    },
    {
      name: 'triple_click',
      description: `Triple-click at the given coordinates. Selects a line in most text editors. Always uses real input. ${GATE_DESC}`,
      inputSchema: {
        type: 'object',
        properties: { coordinate: coordinateTuple, text: modifierText },
        required: ['coordinate'],
      },
    },
    {
      name: 'right_click',
      description: `Right-click at the given coordinates. Opens a context menu in most applications. ${GATE_DESC}`,
      inputSchema: {
        type: 'object',
        properties: { coordinate: coordinateTuple, text: modifierText, input_channel: inputChannel },
        required: ['coordinate'],
      },
    },
    {
      name: 'middle_click',
      description: `Middle-click (scroll-wheel click) at the given coordinates. ${GATE_DESC}`,
      inputSchema: {
        type: 'object',
        properties: { coordinate: coordinateTuple, text: modifierText, input_channel: inputChannel },
        required: ['coordinate'],
      },
    },
    {
      name: 'type',
      description:
        `Type text into whatever currently has keyboard focus. ${GATE_DESC} Newlines are supported. ` +
        'Unicode (Chinese, emoji, symbols) is sent as Unicode key events, so no clipboard is involved. For shortcuts use `key` instead.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: MAX_TYPE_TEXT_LENGTH, description: 'Text to type.' } },
        required: ['text'],
      },
    },
    {
      name: 'key',
      description:
        `Press a key or key combination (e.g. "return", "escape", "ctrl+a", "ctrl+shift+tab"). ${GATE_DESC} ` +
        'System-level combos (Win key, Alt+F4, Alt+Tab, Ctrl+Shift+Esc) need the systemKeyCombos policy flag; without it they return an error. All other combos work.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Key or chord, modifiers joined with "+", e.g. "ctrl+shift+a".' },
          repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'Times to repeat. Default 1.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'hold_key',
      description:
        `Press and hold a key or chord for a duration, then release. ${GATE_DESC} System-level combos require the systemKeyCombos flag.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Key or chord to hold, e.g. "space", "shift+down".' },
          duration: { type: 'number', description: 'Seconds (0-100).' },
        },
        required: ['text', 'duration'],
      },
    },
    {
      name: 'scroll',
      description: `Scroll at the given coordinates. ${GATE_DESC} One unit is one wheel notch.`,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordinateTuple,
          scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll.' },
          scroll_amount: { type: 'integer', minimum: 0, maximum: 100, description: 'Number of wheel ticks.' },
        },
        required: ['coordinate', 'scroll_direction', 'scroll_amount'],
      },
    },
    {
      name: 'left_click_drag',
      description: `Press, move to the end point, and release. ${GATE_DESC}`,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: { ...coordinateTuple, description: `(x, y) end point: ${coord.x}` },
          start_coordinate: {
            ...coordinateTuple,
            description: `(x, y) start point. If omitted, drags from the current cursor position. ${coord.x}`,
          },
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'mouse_move',
      description: `Move the mouse cursor without clicking; useful for hover states and for positioning before left_mouse_down. ${GATE_DESC}`,
      inputSchema: {
        type: 'object',
        properties: { coordinate: coordinateTuple },
        required: ['coordinate'],
      },
    },
    {
      name: 'left_mouse_down',
      description:
        `Press the left button at the current cursor position and leave it held. ${GATE_DESC} ` +
        'Position the cursor with mouse_move first, then release with left_mouse_up. Errors if the button is already held.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'left_mouse_up',
      description: `Release the left button at the current cursor position. Pairs with left_mouse_down; safe to call even when not held. ${GATE_DESC}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'cursor_position',
      description:
        'Current cursor position. Returns both screenshot pixel coordinates (relative to the last screenshot, if any) and physical screen coordinates.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_clipboard',
      description: 'Read the clipboard as text. Requires the clipboardRead policy flag.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'write_clipboard',
      description: 'Overwrite the clipboard with text. Requires the clipboardWrite policy flag. Destroys the previous clipboard content.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for a duration, e.g. for an application to finish loading. Prefer this to rapid polling with screenshots.',
      inputSchema: {
        type: 'object',
        properties: { duration: { type: 'number', description: 'Seconds (0-100).' } },
        required: ['duration'],
      },
    },
    {
      name: 'computer_batch',
      description:
        'Execute several actions in ONE tool call. Each individual tool call costs a model round trip; batching a predictable sequence removes all but one. ' +
        'Actions run sequentially and stop at the first error. Every action is validated before the first side effect. ' +
        `${GATE_DESC} The target check runs before EACH action. ` +
        'Screenshots inside a batch are for inspection: coordinates for all actions refer to the PRE-BATCH screenshot. ' +
        `Limits: ${MAX_BATCH_ACTIONS} actions, 4 screenshots, 20 MiB of images.`,
      inputSchema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH_ACTIONS,
            items: BATCH_ITEM_SCHEMA,
            description:
              'Actions in order. Example: [{"action":"left_click","coordinate":[100,200]},{"action":"type","text":"hello"},{"action":"key","text":"Return"}]',
          },
        },
        required: ['actions'],
      },
    },
  ]
}
