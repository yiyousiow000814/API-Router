const HIDDEN_WEB_SLASH_COMMANDS = new Set([
  "/model",
  "/new",
  "/status",
  "/fork",
  "/rename",
]);

export function normalizeSlashCommandCatalog(payload) {
  const raw = Array.isArray(payload?.commands) ? payload.commands : [];
  return raw
    .flatMap((item) => {
      const command = String(item?.command || "").trim();
      if (!command.startsWith("/")) return [];
      if (HIDDEN_WEB_SLASH_COMMANDS.has(command)) return [];
      if (command === "/plan") {
        return [
          {
            command: "/plan on",
            usage: "/plan on",
            insertText: "/plan on",
            description: "Enable plan mode.",
          },
          {
            command: "/plan off",
            usage: "/plan off",
            insertText: "/plan off",
            description: "Disable plan mode.",
          },
        ];
      }
      const usage = String(item?.usage || command).trim() || command;
      const insertText = String(item?.insertText || item?.insert_text || command).replace(/\r\n/g, "\n");
      const description = String(item?.description || "").trim();
      return [{
        command,
        usage,
        insertText: insertText || command,
        description,
      }];
    })
    .filter(Boolean);
}

export function readSlashSearchQuery(prompt) {
  const text = String(prompt || "");
  if (!text.startsWith("/")) return "";
  const match = text.match(/^\/([^\s]*)$/);
  return match ? String(match[1] || "").trim().toLowerCase() : "";
}

export function filterSlashCommands(commands, prompt) {
  const query = readSlashSearchQuery(prompt);
  if (query === "" && !String(prompt || "").startsWith("/")) return [];
  const list = Array.isArray(commands) ? commands : [];
  if (!query) return list.slice();
  return list.filter((item) => {
    const command = String(item?.command || "").toLowerCase();
    const usage = String(item?.usage || "").toLowerCase();
    const description = String(item?.description || "").toLowerCase();
    return command.startsWith(`/${query}`) || usage.includes(query) || description.includes(query);
  });
}

function matchesCommittedSlashCommand(commands, prompt) {
  const text = String(prompt || "").trim();
  if (!text.startsWith("/")) return false;
  const list = Array.isArray(commands) ? commands : [];
  return list.some((item) => {
    const command = String(item?.command || "").trim();
    const insertText = String(item?.insertText || "").trim();
    return text === command || (insertText && text === insertText);
  });
}

function shouldOpenSlashMenu(prompt, commands) {
  const text = String(prompt || "");
  return text.startsWith("/") && /^\/[^\s]*$/.test(text) && !matchesCommittedSlashCommand(commands, text);
}

function revealSelectedSlashCommand(menu, selectedIndex) {
  if (!menu?.querySelector?.bind) return;
  const node = menu.querySelector(`[data-slash-index="${String(selectedIndex)}"]`);
  if (!node?.scrollIntoView) return;
  try {
    node.scrollIntoView({ block: "nearest" });
  } catch {}
}

export function createSlashCommandsModule(deps) {
  const {
    state,
    byId,
    api,
    escapeHtml = (value) => String(value || ""),
    updateMobileComposerState = () => {},
    setStatus = () => {},
    windowRef = typeof window === "undefined" ? null : window,
  } = deps;

  let loadPromise = null;
  let positionListenersInstalled = false;

  function selectedCommand() {
    const items = Array.isArray(state.slashMenuItems) ? state.slashMenuItems : [];
    if (!items.length) return null;
    const index = Math.max(0, Math.min(items.length - 1, Number(state.slashMenuSelectedIndex || 0)));
    return items[index] || null;
  }

  function resetSlashMenuPosition(menu) {
    if (!menu?.style) return;
    menu.style.position = "";
    menu.style.left = "";
    menu.style.top = "";
    menu.style.right = "";
    menu.style.bottom = "";
    menu.style.width = "";
    menu.style.maxWidth = "";
    menu.style.transform = "";
  }

  function positionSlashMenu(menu) {
    if (!menu?.style) return;
    const wrap = byId("mobilePromptWrap");
    const input = byId("mobilePromptInput");
    const anchor = wrap || input;
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) {
      resetSlashMenuPosition(menu);
      return;
    }
    const viewportWidth = Number(windowRef?.innerWidth || 0) || rect.width || 0;
    const margin = 8;
    const desiredWidth = Math.max(220, rect.width);
    const maxWidth = Math.max(220, viewportWidth - margin * 2);
    const width = Math.min(desiredWidth, maxWidth);
    const left = Math.min(
      Math.max(margin, rect.left + (rect.width - width) / 2),
      Math.max(margin, viewportWidth - width - margin)
    );
    const top = Math.max(margin, rect.top - 8);
    menu.style.position = "fixed";
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.right = "auto";
    menu.style.bottom = "auto";
    menu.style.width = `${Math.round(width)}px`;
    menu.style.maxWidth = `${Math.round(maxWidth)}px`;
    menu.style.transform = "translateY(-100%)";
  }

  function installPositionListeners() {
    if (positionListenersInstalled || !windowRef?.addEventListener) return;
    positionListenersInstalled = true;
    const sync = () => {
      if (state.slashMenuOpen === true) renderSlashMenu();
    };
    windowRef.addEventListener("resize", sync);
    windowRef.addEventListener("scroll", sync, true);
  }

  function renderSlashMenu() {
    const menu = byId("slashCommandMenu");
    if (!menu) return;
    installPositionListeners();
    const open = state.slashMenuOpen === true;
    const items = Array.isArray(state.slashMenuItems) ? state.slashMenuItems : [];
    if (!open) {
      menu.style.display = "none";
      resetSlashMenuPosition(menu);
      menu.innerHTML = "";
      return;
    }
    let html = "";
    if (state.slashCommandsLoading === true) {
      html = '<div class="slashCommandState">Loading slash commands...</div>';
    } else if (state.slashCommandsError) {
      html = `<div class="slashCommandState error">${escapeHtml(state.slashCommandsError)}</div>`;
    } else if (!items.length) {
      html = '<div class="slashCommandState">No matching slash commands.</div>';
    } else {
      html = items
        .map((item, index) => {
          const selected = index === Number(state.slashMenuSelectedIndex || 0);
          return (
            `<button type="button" class="slashCommandItem${selected ? " is-selected" : ""}" data-slash-index="${String(index)}">` +
              `<span class="slashCommandMain">` +
                `<span class="slashCommandName">${escapeHtml(item.command)}</span>` +
                `<span class="slashCommandUsage">${escapeHtml(item.usage)}</span>` +
              `</span>` +
              `<span class="slashCommandDesc">${escapeHtml(item.description || "")}</span>` +
            `</button>`
          );
        })
        .join("");
    }
    menu.innerHTML = html;
    positionSlashMenu(menu);
    menu.style.display = "block";
    const selectedIndex = Number(state.slashMenuSelectedIndex || 0);
    revealSelectedSlashCommand(menu, selectedIndex);
    for (const node of Array.from(menu.querySelectorAll?.("[data-slash-index]") || [])) {
      const applyFromNode = (event) => {
        event?.preventDefault?.();
        const index = Number(node.getAttribute("data-slash-index"));
        if (!Number.isInteger(index)) return;
        state.slashMenuSelectedIndex = index;
        applySelectedSlashCommand();
      };
      node.addEventListener("pointerdown", applyFromNode);
      node.addEventListener("mousedown", applyFromNode);
      node.addEventListener("click", applyFromNode);
    }
  }

  function hideSlashCommandMenu() {
    state.slashMenuOpen = false;
    state.slashMenuItems = [];
    state.slashMenuSelectedIndex = 0;
    renderSlashMenu();
  }

  async function refreshSlashCommands(options = {}) {
    if (state.slashCommandsLoaded === true && options.force !== true) return state.slashCommands;
    if (loadPromise) return loadPromise;
    state.slashCommandsLoading = true;
    state.slashCommandsError = "";
    renderSlashMenu();
    loadPromise = api("/codex/slash/commands")
      .then((payload) => {
        state.slashCommands = normalizeSlashCommandCatalog(payload);
        state.slashCommandsLoaded = true;
        state.slashCommandsError = "";
        return state.slashCommands;
      })
      .catch((error) => {
        state.slashCommandsError = error?.message || "Failed to load slash commands.";
        setStatus(state.slashCommandsError, true);
        return [];
      })
      .finally(() => {
        state.slashCommandsLoading = false;
        loadPromise = null;
        syncSlashCommandMenu();
      });
    return loadPromise;
  }

  function syncSlashCommandMenu() {
    const promptValue = String(byId("mobilePromptInput")?.value || "");
    const items = filterSlashCommands(state.slashCommands, promptValue);
    const shouldOpen = shouldOpenSlashMenu(promptValue, state.slashCommands);
    state.slashMenuOpen = shouldOpen;
    state.slashMenuItems = items;
    if (!items.length) state.slashMenuSelectedIndex = 0;
    else state.slashMenuSelectedIndex = Math.max(0, Math.min(items.length - 1, Number(state.slashMenuSelectedIndex || 0)));
    renderSlashMenu();
    if (shouldOpen && state.slashCommandsLoaded !== true && state.slashCommandsLoading !== true) {
      refreshSlashCommands().catch(() => {});
    }
  }

  function moveSlashCommandSelection(delta) {
    const items = Array.isArray(state.slashMenuItems) ? state.slashMenuItems : [];
    if (!state.slashMenuOpen || !items.length) return false;
    const current = Math.max(0, Math.min(items.length - 1, Number(state.slashMenuSelectedIndex || 0)));
    const next = (current + delta + items.length) % items.length;
    state.slashMenuSelectedIndex = next;
    renderSlashMenu();
    return true;
  }

  function applySelectedSlashCommand() {
    const input = byId("mobilePromptInput");
    const item = selectedCommand();
    if (!input || !item) return false;
    input.value = item.insertText;
    updateMobileComposerState();
    hideSlashCommandMenu();
    try {
      const end = String(input.value || "").length;
      input.focus?.();
      input.setSelectionRange?.(end, end);
    } catch {}
    return true;
  }

  function handleSlashCommandKeyDown(event) {
    if (state.slashMenuOpen !== true) return false;
    const key = String(event?.key || "");
    if (key === "ArrowDown") {
      event.preventDefault();
      return moveSlashCommandSelection(1);
    }
    if (key === "ArrowUp") {
      event.preventDefault();
      return moveSlashCommandSelection(-1);
    }
    if (key === "Tab" || key === "Enter") {
      event.preventDefault();
      return applySelectedSlashCommand();
    }
    if (key === "Escape") {
      event.preventDefault();
      hideSlashCommandMenu();
      return true;
    }
    return false;
  }

  return {
    applySelectedSlashCommand,
    handleSlashCommandKeyDown,
    hideSlashCommandMenu,
    refreshSlashCommands,
    renderSlashMenu,
    syncSlashCommandMenu,
  };
}
