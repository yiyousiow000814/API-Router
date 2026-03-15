const HIDDEN_WEB_SLASH_COMMANDS = new Set([
  "/help",
  "/model",
  "/new",
  "/status",
  "/fork",
  "/rename",
]);

const REVIEW_PRESET_ITEMS = [
  {
    label: "Review against a base branch",
    description: "(PR Style)",
    action: "base-branch",
  },
  {
    label: "Review uncommitted changes",
    description: "",
    action: "uncommitted",
  },
  {
    label: "Review a commit",
    description: "",
    action: "commit",
  },
  {
    label: "Custom review instructions",
    description: "",
    action: "custom",
  },
];

function normalizeSlashCommandItem(item) {
  const command = String(item?.command || "").trim();
  if (!command.startsWith("/")) return null;
  if (HIDDEN_WEB_SLASH_COMMANDS.has(command)) return null;
  const usage = String(item?.usage || command).trim() || command;
  const insertText = String(item?.insertText || item?.insert_text || command).replace(/\r\n/g, "\n") || command;
  const description = String(item?.description || "").trim();
  const children = Array.isArray(item?.children)
    ? item.children.map(normalizeSlashCommandItem).filter(Boolean)
    : [];
  return {
    command,
    usage,
    insertText,
    description,
    active: item?.active === true,
    children,
  };
}

export function normalizeSlashCommandCatalog(payload) {
  const raw = Array.isArray(payload?.commands) ? payload.commands : [];
  return raw.map(normalizeSlashCommandItem).filter(Boolean);
}

export function readSlashSearchQuery(prompt) {
  const text = String(prompt || "");
  if (!text.startsWith("/")) return "";
  const match = text.match(/^\/([^\s]*)$/);
  return match ? String(match[1] || "").trim().toLowerCase() : "";
}

function findSlashCommandByCommand(commands, command) {
  const list = Array.isArray(commands) ? commands : [];
  const normalized = String(command || "").trim();
  for (const item of list) {
    if (String(item?.command || "").trim() === normalized) return item;
    const child = findSlashCommandByCommand(item?.children || [], normalized);
    if (child) return child;
  }
  return null;
}

function matchesCommittedSlashCommand(commands, prompt) {
  const text = String(prompt || "").trim();
  if (!text.startsWith("/")) return false;
  const item = findSlashCommandByCommand(commands, text);
  if (!item) return false;
  if (Array.isArray(item.children) && item.children.length) return false;
  const insertText = String(item?.insertText || "").trim();
  return text === item.command || (insertText && text === insertText);
}

function resolveSlashMenuContext(commands, prompt) {
  const text = String(prompt || "").trim();
  const list = Array.isArray(commands) ? commands : [];
  if (!text.startsWith("/")) return { items: [], parent: null };
  const exact = findSlashCommandByCommand(list, text);
  if (exact && Array.isArray(exact.children) && exact.children.length) {
    return { items: exact.children.slice(), parent: exact };
  }
  const query = readSlashSearchQuery(text);
  if (query === "" && text !== "/") return { items: [], parent: null };
  const items = !query
    ? list.slice()
    : list.filter((item) => {
        const command = String(item?.command || "").toLowerCase();
        const usage = String(item?.usage || "").toLowerCase();
        return command.startsWith(`/${query}`) || usage.startsWith(`/${query}`);
      });
  return { items, parent: null };
}

export function filterSlashCommands(commands, prompt) {
  return resolveSlashMenuContext(commands, prompt).items;
}

function slashMenuContextKey(prompt, context) {
  const text = String(prompt || "").trim();
  const parentCommand = String(context?.parent?.command || "").trim();
  if (parentCommand) return `parent:${parentCommand}`;
  return `root:${text}`;
}

function shouldOpenSlashMenu(prompt, commands) {
  const text = String(prompt || "");
  if (!text.startsWith("/")) return false;
  if (text.trim() === "/review") return true;
  if (matchesCommittedSlashCommand(commands, text)) return false;
  const context = resolveSlashMenuContext(commands, text);
  return Array.isArray(context.items) && context.items.length > 0
    ? true
    : /^\/[^\s]*$/.test(text);
}

function shouldHandlePrimaryActivation(event) {
  if (!event) return true;
  const type = String(event.type || "");
  if (type === "pointerdown" || type === "pointerup") {
    if (event.isPrimary === false) return false;
    if (typeof event.button === "number" && event.button !== 0) return false;
    return true;
  }
  if (type === "click") {
    if (typeof event.button === "number" && event.button !== 0) return false;
    return true;
  }
  return false;
}

function stopMenuEvent(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
}

function filterReviewOptions(items, query) {
  const needle = String(query || "").trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];
  if (!needle) return list.slice();
  return list.filter((item) => {
    const label = String(item?.label || "").toLowerCase();
    const description = String(item?.description || "").toLowerCase();
    const searchValue = String(item?.searchValue || item?.search_value || "").toLowerCase();
    return label.includes(needle) || description.includes(needle) || searchValue.includes(needle);
  });
}

function reviewCacheKey(kind, workspace, cwd) {
  return `${String(kind || "").trim()}|${String(workspace || "").trim()}|${String(cwd || "").trim()}`;
}

function parseReviewBranchLabel(label) {
  const raw = String(label || "").trim();
  const match = raw.match(/^(.*?)\s*->\s*(.+)$/);
  if (!match) return null;
  return {
    source: String(match[1] || "").trim(),
    target: String(match[2] || "").trim(),
  };
}

function reviewBranchHeader(items) {
  const parsed = (Array.isArray(items) ? items : [])
    .map((item) => parseReviewBranchLabel(item?.label))
    .filter(Boolean);
  if (!parsed.length) return "";
  const source = String(parsed[0]?.source || "").trim();
  if (!source) return "";
  return parsed.every((entry) => entry.source === source) ? source : "";
}

function normalizeReviewBranchItems(items) {
  const normalized = (Array.isArray(items) ? items : []).map((item) => {
    const parsed = parseReviewBranchLabel(item?.label);
    if (!parsed?.target) return item;
    return {
      ...item,
      compactLabel: parsed.target,
    };
  });
  const prioritized = [];
  const remaining = [];
  for (const item of normalized) {
    const branch = String(item?.value || item?.compactLabel || item?.label || "").trim().toLowerCase();
    if (branch === "main") {
      prioritized.push(item);
    } else {
      remaining.push(item);
    }
  }
  return prioritized.concat(remaining);
}

function normalizeReviewOption(item) {
  const value = String(item?.value || "").trim();
  const label = String(item?.label || value).trim();
  if (!value || !label) return null;
  return {
    value,
    label,
    description: String(item?.description || "").trim(),
    searchValue: String(item?.searchValue || item?.search_value || "").trim(),
  };
}

export function createSlashCommandsModule(deps) {
  const {
    state,
    byId,
    api,
    armSyntheticClickSuppression = () => {},
    executeSlashCommand = async () => null,
    getWorkspaceTarget = () => String(state.activeThreadWorkspace || state.workspaceTarget || "windows"),
    getStartCwdForWorkspace = () => "",
    escapeHtml = (value) => String(value || ""),
    updateMobileComposerState = () => {},
    setStatus = () => {},
    documentRef = typeof document === "undefined" ? null : document,
    windowRef = typeof window === "undefined" ? null : window,
  } = deps;

  let loadPromise = null;
  let positionListenersInstalled = false;
  let lastRenderedMenuViewKey = "";
  let menuViewTransitionTimer = 0;
  let lastPointerMenuActivationAt = 0;
  let lastMenuInteractionAt = 0;
  const scheduleFrame = typeof windowRef?.requestAnimationFrame === "function"
    ? windowRef.requestAnimationFrame.bind(windowRef)
    : ((cb) => cb());
  const reviewOptionsCache = new Map();
  const reviewOptionsInflight = new Map();
  let specialMenu = {
    mode: "",
    query: "",
    draft: "",
    items: [],
    loading: false,
    error: "",
  };

  function currentPromptValue() {
    return String(byId("mobilePromptInput")?.value || "");
  }

  function promptHasFocus() {
    const input = byId("mobilePromptInput");
    if (!input) return false;
    const activeElement = documentRef?.activeElement;
    if (activeElement == null) return true;
    if (activeElement === input) return true;
    const menu = byId("slashCommandMenu");
    if (menu && typeof menu.contains === "function" && menu.contains(activeElement)) return true;
    if (Date.now() - Number(lastMenuInteractionAt || 0) <= 520) return true;
    return false;
  }

  function markMenuInteraction() {
    lastMenuInteractionAt = Date.now();
  }

  function currentWorkspaceTarget() {
    const value = String(getWorkspaceTarget() || state.activeThreadWorkspace || state.workspaceTarget || "windows")
      .trim()
      .toLowerCase();
    return value === "wsl2" ? "wsl2" : "windows";
  }

  function currentStartCwd() {
    const activeThreadId = String(state.activeThreadId || "").trim();
    if (activeThreadId && Array.isArray(state.threadItemsAll)) {
      const thread = state.threadItemsAll.find((item) => String(item?.id || "").trim() === activeThreadId);
      const threadCwd = String(
        thread?.cwd || thread?.project || thread?.directory || thread?.path || ""
      ).trim();
      if (threadCwd) return threadCwd;
    }
    return String(getStartCwdForWorkspace(currentWorkspaceTarget()) || "").trim();
  }

  function currentMenuContext() {
    return resolveSlashMenuContext(state.slashCommands, currentPromptValue());
  }

  function currentPermissionPreset() {
    const workspace = currentWorkspaceTarget();
    return String(state.permissionPresetByWorkspace?.[workspace] || "").trim().toLowerCase();
  }

  function currentSlashCatalogContextKey() {
    return [
      currentWorkspaceTarget(),
      String(state.activeThreadId || "").trim(),
      String(state.activeThreadRolloutPath || "").trim(),
    ].join("|");
  }

  function findCatalogCommand(command) {
    return findSlashCommandByCommand(state.slashCommands, command);
  }

  function syncLocalSlashStateFromCatalog() {
    const fast = findCatalogCommand("/fast");
    const fastChildren = Array.isArray(fast?.children) ? fast.children : [];
    if (fastChildren.some((child) => child?.active === true)) {
      state.fastModeEnabled = fastChildren.some((child) => String(child?.command || "").trim() === "/fast on" && child.active === true);
    }
    const plan = findCatalogCommand("/plan");
    const planChildren = Array.isArray(plan?.children) ? plan.children : [];
    if (planChildren.some((child) => child?.active === true)) {
      state.planModeEnabled = planChildren.some((child) => String(child?.command || "").trim() === "/plan on" && child.active === true);
    }
    const permission = findCatalogCommand("/permission");
    const permissionChildren = Array.isArray(permission?.children) ? permission.children : [];
    const activePermission = permissionChildren.find((child) => child?.active === true);
    if (activePermission?.command) {
      const workspace = currentWorkspaceTarget();
      state.permissionPresetByWorkspace[workspace] = String(activePermission.command || "").trim();
    }
  }

  function isSelectionCommandParent(item) {
    const command = String(item?.command || "").trim().toLowerCase();
    return command === "/plan" || command === "/fast" || command === "/permission";
  }

  function isActiveSlashItem(item, context = {}) {
    if (!item) return false;
    const command = String(item.command || "").trim().toLowerCase();
    if (item.active === true) return true;
    const parentChildren = Array.isArray(context?.parent?.children) ? context.parent.children : [];
    const hasBackendActive = parentChildren.some((child) => child?.active === true);
    if (hasBackendActive && isSelectionCommandParent(context.parent)) return false;
    if (command === "/plan on") return state.planModeEnabled === true;
    if (command === "/plan off") return state.planModeEnabled !== true;
    if (command === "/fast on") return state.fastModeEnabled === true;
    if (command === "/fast off") return state.fastModeEnabled !== true;
    if (command.startsWith("/permission ")) {
      const preset = currentPermissionPreset();
      if (preset) return preset === command;
    }
    if (context.parent && isSelectionCommandParent(context.parent)) return item.active === true;
    return item.active === true;
  }

  function specialMenuOpen() {
    return String(specialMenu.mode || "").startsWith("review-");
  }

  function resetSpecialMenu() {
    specialMenu = {
      mode: "",
      query: "",
      draft: "",
      items: [],
      loading: false,
      error: "",
    };
  }

  function setSpecialMenuMode(mode, options = {}) {
    specialMenu.mode = String(mode || "").trim();
    specialMenu.query = String(options.query || "");
    specialMenu.draft = String(options.draft || "");
    specialMenu.items = Array.isArray(options.items) ? options.items.slice() : [];
    specialMenu.loading = options.loading === true;
    specialMenu.error = String(options.error || "");
    state.slashMenuSelectedIndex = 0;
    state.slashMenuSelectionVisible = false;
  }

  function filteredSpecialItems() {
    if (specialMenu.mode === "review-presets") return filterReviewOptions(REVIEW_PRESET_ITEMS, specialMenu.query);
    if (specialMenu.mode === "review-branches" || specialMenu.mode === "review-commits") {
      return filterReviewOptions(specialMenu.items, specialMenu.query);
    }
    return [];
  }

  function selectedCommand() {
    const items = specialMenuOpen()
      ? filteredSpecialItems()
      : (Array.isArray(state.slashMenuItems) ? state.slashMenuItems : []);
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
    const sync = (event) => {
      if (state.slashMenuOpen !== true) return;
      const menu = byId("slashCommandMenu");
      if (event?.target && menu?.contains?.(event.target)) return;
      positionSlashMenu(menu);
    };
    windowRef.addEventListener("resize", sync);
    windowRef.addEventListener("scroll", sync, true);
  }

  function focusSpecialInput() {
    const menu = byId("slashCommandMenu");
    const field = menu?.querySelector?.("[data-slash-special-input='true']");
    field?.focus?.();
    if (field?.setSelectionRange && typeof field.value === "string") {
      const end = field.value.length;
      try {
        field.setSelectionRange(end, end);
      } catch {}
    }
  }

  function reviewHeaderHtml(title) {
    return (
      `<div class="slashCommandHeader">` +
        `<button type="button" class="slashCommandBackBtn" data-slash-back="true" aria-label="Back to slash commands">` +
          `<span aria-hidden="true">‹</span>` +
        `</button>` +
        `<div class="slashCommandHeaderTitle">${escapeHtml(title)}</div>` +
      `</div>`
    );
  }

  function reviewListHtml(title, items, placeholder) {
    const list = Array.isArray(items) ? items : [];
    let html = reviewHeaderHtml(title);
    if (placeholder) {
      html += (
        `<div class="slashCommandSearchWrap">` +
          `<input type="text" class="slashCommandSearchInput" data-slash-special-input="true" data-slash-search="true" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(specialMenu.query)}" />` +
        `</div>`
      );
    }
    if (specialMenu.loading === true) {
      html += '<div class="slashCommandScroll slashCommandScroll-loading">';
      for (let i = 0; i < 5; i += 1) {
        html += (
          `<div class="slashCommandSkeletonItem" aria-hidden="true">` +
            `<span class="slashCommandSkeletonLine short"></span>` +
            `<span class="slashCommandSkeletonLine long"></span>` +
          `</div>`
        );
      }
      html += "</div>";
      return html;
    }
    if (specialMenu.error) {
      return html + `<div class="slashCommandState error">${escapeHtml(specialMenu.error)}</div>`;
    }
    if (!list.length) {
      return html + '<div class="slashCommandState">No matching review options.</div>';
    }
    const displayItems = specialMenu.mode === "review-branches" ? normalizeReviewBranchItems(list) : list;
    const branchHeader = specialMenu.mode === "review-branches" ? reviewBranchHeader(list) : "";
    html += `<div class="slashCommandScroll">`;
    if (branchHeader) {
      html += `<div class="slashCommandSectionLabel">${escapeHtml(branchHeader)}</div>`;
    }
    html += displayItems.map((item, index) => {
      const selected = state.slashMenuSelectionVisible === true && index === Number(state.slashMenuSelectedIndex || 0);
      const compactLabel = String(item?.compactLabel || "").trim();
      const labelText = compactLabel || item.label;
      return (
        `<button type="button" class="slashCommandItem${selected ? " is-selected" : ""}${compactLabel ? " is-review-branch" : ""}" data-slash-index="${String(index)}">` +
          `<span class="slashCommandMain">` +
            `${compactLabel ? `<span class="slashCommandBranchGlyph" aria-hidden="true">↳</span>` : ""}` +
            `<span class="slashCommandName">${escapeHtml(labelText)}</span>` +
            `${item.description ? `<span class="slashCommandUsage">${escapeHtml(item.description)}</span>` : ""}` +
          `</span>` +
        `</button>`
      );
    }).join("");
    html += `</div>`;
    return html;
  }

  function reviewCustomHtml() {
    return (
      reviewHeaderHtml("Custom review instructions") +
      `<div class="slashCommandSearchWrap">` +
        `<textarea class="slashCommandTextArea" data-slash-special-input="true" data-slash-custom="true" rows="3" placeholder="Type instructions and press Enter">${escapeHtml(specialMenu.draft)}</textarea>` +
      `</div>` +
      `<div class="slashCommandHint">Press Enter to confirm or Esc to go back</div>`
    );
  }

  function renderSlashMenu(options = {}) {
    const menu = byId("slashCommandMenu");
    if (!menu) return;
    installPositionListeners();
    const open = state.slashMenuOpen === true;
    const items = Array.isArray(state.slashMenuItems) ? state.slashMenuItems : [];
    const context = currentMenuContext();
    if (!open) {
      if (menuViewTransitionTimer) {
        clearTimeout(menuViewTransitionTimer);
        menuViewTransitionTimer = 0;
      }
      menu.classList?.remove?.("is-view-transition");
      lastRenderedMenuViewKey = "";
      menu.style.display = "none";
      resetSlashMenuPosition(menu);
      menu.innerHTML = "";
      return;
    }
    let html = "";
    if (specialMenuOpen()) {
      if (specialMenu.mode === "review-presets") {
        html = reviewListHtml("Select a review preset", filteredSpecialItems(), "");
      } else if (specialMenu.mode === "review-branches") {
        html = reviewListHtml("Select a base branch", filteredSpecialItems(), "Type to search branches");
      } else if (specialMenu.mode === "review-commits") {
        html = reviewListHtml("Select a commit to review", filteredSpecialItems(), "Type to search commits");
      } else if (specialMenu.mode === "review-custom") {
        html = reviewCustomHtml();
      }
    } else if (state.slashCommandsLoading === true) {
      html = '<div class="slashCommandState">Loading slash commands...</div>';
    } else if (state.slashCommandsError) {
      html = `<div class="slashCommandState error">${escapeHtml(state.slashCommandsError)}</div>`;
    } else if (!items.length) {
      html = '<div class="slashCommandState">No matching slash commands.</div>';
    } else {
      const headerHtml = context.parent
        ? (
            `<div class="slashCommandHeader">` +
              `<button type="button" class="slashCommandBackBtn" data-slash-back="true" aria-label="Back to slash commands">` +
                `<span aria-hidden="true">‹</span>` +
              `</button>` +
              `<div class="slashCommandHeaderTitle">${escapeHtml(context.parent.command)}</div>` +
            `</div>`
          )
        : "";
      html =
        headerHtml +
        `<div class="slashCommandScroll">` +
        items
          .map((item, index) => {
            const selected =
              state.slashMenuSelectionVisible === true &&
              index === Number(state.slashMenuSelectedIndex || 0);
            const hasChildren = Array.isArray(item?.children) && item.children.length > 0;
            const usageText = hasChildren
              ? "Select"
              : (String(item.usage || "").trim() === String(item.command || "").trim() ? "" : item.usage);
            const active = isActiveSlashItem(item, context);
            return (
              `<button type="button" class="slashCommandItem${selected ? " is-selected" : ""}" data-slash-index="${String(index)}">` +
                `<span class="slashCommandMain">` +
                  `<span class="slashCommandName">${escapeHtml(item.command)}</span>` +
                  `${usageText ? `<span class="slashCommandUsage">${escapeHtml(usageText)}</span>` : ""}` +
                `</span>` +
                `<span class="slashCommandMeta">` +
                  `<span class="slashCommandDesc">${escapeHtml(item.description || "")}</span>` +
                  `<span class="slashCommandCheck${active ? " is-active" : ""}" aria-hidden="true">${active ? "✓" : ""}</span>` +
                `</span>` +
              `</button>`
            );
          })
          .join("") +
        `</div>`;
    }
    menu.innerHTML = html;
    positionSlashMenu(menu);
    menu.style.display = "block";
    const nextViewKey = specialMenuOpen()
      ? `special:${specialMenu.mode}:${specialMenu.query}:${specialMenu.draft}`
      : `menu:${String(context?.parent?.command || "")}:${items.map((item) => String(item?.command || "")).join("|")}`;
    const shouldAnimateView = options.animateView !== false && lastRenderedMenuViewKey && lastRenderedMenuViewKey !== nextViewKey;
    lastRenderedMenuViewKey = nextViewKey;
    if (menuViewTransitionTimer) {
      clearTimeout(menuViewTransitionTimer);
      menuViewTransitionTimer = 0;
    }
    menu.classList?.remove?.("is-view-transition");
    if (shouldAnimateView) {
      try {
        void menu.offsetWidth;
      } catch {}
      menu.classList?.add?.("is-view-transition");
      menuViewTransitionTimer = setTimeout(() => {
        menu.classList?.remove?.("is-view-transition");
        menuViewTransitionTimer = 0;
      }, 220);
    }
    menu.addEventListener?.("pointerdown", (event) => {
      markMenuInteraction();
      event?.stopPropagation?.();
    });
    menu.addEventListener?.("click", (event) => {
      markMenuInteraction();
      stopMenuEvent(event);
    });
    if (options.revealSelection === true) {
      const selectedIndex = Number(state.slashMenuSelectedIndex || 0);
      scheduleFrame(() => {
        if (!menu?.querySelector?.bind) return;
        const node = menu.querySelector(`[data-slash-index="${String(selectedIndex)}"]`);
        if (!node) return;
        const scrollBox = menu.querySelector(".slashCommandScroll");
        const top = Number(node?.offsetTop);
        const height = Number(node?.offsetHeight);
        const scrollTop = Number(scrollBox?.scrollTop);
        const clientHeight = Number(scrollBox?.clientHeight);
        if (
          scrollBox &&
          Number.isFinite(top) &&
          Number.isFinite(height) &&
          Number.isFinite(scrollTop) &&
          Number.isFinite(clientHeight) &&
          clientHeight > 0
        ) {
          const nextTop = Math.max(0, top - 8);
          const nextBottom = top + height + 8;
          if (nextTop < scrollTop) {
            scrollBox.scrollTop = nextTop;
            return;
          }
          if (nextBottom > scrollTop + clientHeight) {
            scrollBox.scrollTop = Math.max(0, nextBottom - clientHeight);
            return;
          }
        }
        if (!node?.scrollIntoView) return;
        try {
          node.scrollIntoView({ block: "nearest" });
        } catch {}
      });
    }
    if (options.focusSpecialInput === true) {
      focusSpecialInput();
    }
    const backButton = menu.querySelector?.("[data-slash-back='true']");
    backButton?.addEventListener?.("pointerdown", (event) => {
      markMenuInteraction();
      stopMenuEvent(event);
    });
    backButton?.addEventListener?.("pointerup", (event) => {
      if (!shouldHandlePrimaryActivation(event)) return;
      markMenuInteraction();
      lastPointerMenuActivationAt = Date.now();
      armSyntheticClickSuppression(420);
      stopMenuEvent(event);
      navigateBackSlashMenu();
    });
    backButton?.addEventListener?.("click", (event) => {
      if (Date.now() - lastPointerMenuActivationAt <= 500) {
        stopMenuEvent(event);
        return;
      }
      if (!shouldHandlePrimaryActivation(event)) return;
      markMenuInteraction();
      armSyntheticClickSuppression(420);
      stopMenuEvent(event);
      navigateBackSlashMenu();
    });
    const searchInput = menu.querySelector?.("[data-slash-search='true']");
    searchInput?.addEventListener?.("input", (event) => {
      specialMenu.query = String(event?.target?.value || "");
      state.slashMenuSelectedIndex = 0;
      state.slashMenuSelectionVisible = false;
      renderSlashMenu({ focusSpecialInput: true });
    });
    searchInput?.addEventListener?.("keydown", (event) => {
      const key = String(event?.key || "");
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Escape") {
        handleSlashCommandKeyDown(event);
      }
    });
    const customInput = menu.querySelector?.("[data-slash-custom='true']");
    customInput?.addEventListener?.("input", (event) => {
      specialMenu.draft = String(event?.target?.value || "");
    });
    customInput?.addEventListener?.("keydown", (event) => {
      const key = String(event?.key || "");
      if ((key === "Enter" && event.shiftKey !== true) || key === "Escape") {
        handleSlashCommandKeyDown(event);
      }
    });
    for (const node of Array.from(menu.querySelectorAll?.("[data-slash-index]") || [])) {
      const applyFromNode = (event) => {
        if (!shouldHandlePrimaryActivation(event)) return;
        markMenuInteraction();
        armSyntheticClickSuppression(420);
        stopMenuEvent(event);
        const index = Number(node.getAttribute("data-slash-index"));
        if (!Number.isInteger(index)) return;
        state.slashMenuSelectedIndex = index;
        state.slashMenuSelectionVisible = false;
        applySelectedSlashCommand();
      };
      node.addEventListener("pointerdown", (event) => {
        markMenuInteraction();
        stopMenuEvent(event);
      });
      node.addEventListener("pointerup", (event) => {
        lastPointerMenuActivationAt = Date.now();
        applyFromNode(event);
      });
      node.addEventListener("click", (event) => {
        if (Date.now() - lastPointerMenuActivationAt <= 500) {
          stopMenuEvent(event);
          return;
        }
        applyFromNode(event);
      });
    }
  }

  function hideSlashCommandMenu() {
    state.slashMenuOpen = false;
    state.slashMenuItems = [];
    state.slashMenuSelectedIndex = 0;
    state.slashMenuSelectionVisible = false;
    state.slashMenuContextKey = "";
    resetSpecialMenu();
    renderSlashMenu();
  }

  async function refreshSlashCommands(options = {}) {
    const workspace = currentWorkspaceTarget();
    const contextKey = currentSlashCatalogContextKey();
    if (
      state.slashCommandsLoaded === true &&
      options.force !== true &&
      String(state.slashCommandsWorkspace || "") === workspace &&
      String(state.slashCommandsContextKey || "") === contextKey
    ) {
      return state.slashCommands;
    }
    if (loadPromise) return loadPromise;
    state.slashCommandsLoading = true;
    state.slashCommandsError = "";
    if (options.silent !== true) renderSlashMenu();
    const params = new URLSearchParams();
    params.set("workspace", workspace);
    const threadId = String(state.activeThreadId || "").trim();
    const rolloutPath = String(state.activeThreadRolloutPath || "").trim();
    if (threadId) params.set("threadId", threadId);
    if (rolloutPath) params.set("rolloutPath", rolloutPath);
    loadPromise = api(`/codex/slash/commands?${params.toString()}`)
      .then((payload) => {
        state.slashCommands = normalizeSlashCommandCatalog(payload);
        state.slashCommandsLoaded = true;
        state.slashCommandsError = "";
        state.slashCommandsWorkspace = workspace;
        state.slashCommandsContextKey = contextKey;
        syncLocalSlashStateFromCatalog();
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

  async function fetchReviewOptions(kind) {
    const workspace = currentWorkspaceTarget();
    const cwd = currentStartCwd();
    if (!cwd) throw new Error("Select a folder first.");
    const cacheKey = reviewCacheKey(kind, workspace, cwd);
    if (reviewOptionsCache.has(cacheKey)) return reviewOptionsCache.get(cacheKey) || [];
    if (reviewOptionsInflight.has(cacheKey)) return reviewOptionsInflight.get(cacheKey);
    const params = new URLSearchParams();
    params.set("workspace", workspace);
    params.set("cwd", cwd);
    const endpoint = kind === "review-branches"
      ? "/codex/slash/review/branches"
      : "/codex/slash/review/commits";
    const request = api(`${endpoint}?${params.toString()}`)
      .then((payload) => {
        const items = Array.isArray(payload?.items) ? payload.items.map(normalizeReviewOption).filter(Boolean) : [];
        reviewOptionsCache.set(cacheKey, items);
        return items;
      })
      .finally(() => {
        reviewOptionsInflight.delete(cacheKey);
      });
    reviewOptionsInflight.set(cacheKey, request);
    return request;
  }

  function warmReviewOptions() {
    const cwd = currentStartCwd();
    if (!cwd) return;
    fetchReviewOptions("review-branches").catch(() => {});
    fetchReviewOptions("review-commits").catch(() => {});
  }

  async function loadReviewOptions(kind) {
    const workspace = currentWorkspaceTarget();
    const cwd = currentStartCwd();
    if (!cwd) {
      setSpecialMenuMode(kind, { error: "Select a folder first." });
      renderSlashMenu({ focusSpecialInput: kind !== "review-presets" });
      return;
    }
    const cacheKey = reviewCacheKey(kind, workspace, cwd);
    const cached = reviewOptionsCache.get(cacheKey);
    if (Array.isArray(cached) && cached.length) {
      setSpecialMenuMode(kind, { items: cached });
      renderSlashMenu({ focusSpecialInput: true });
      return;
    }
    setSpecialMenuMode(kind, { loading: true });
    renderSlashMenu({ focusSpecialInput: kind !== "review-presets" });
    try {
      const items = await fetchReviewOptions(kind);
      setSpecialMenuMode(kind, { items });
    } catch (error) {
      setSpecialMenuMode(kind, { error: error?.message || "Failed to load review options." });
      setStatus(specialMenu.error, true);
    }
    renderSlashMenu({ focusSpecialInput: true });
  }

  function syncSlashCommandMenu() {
    const promptValue = currentPromptValue();
    const trimmedPrompt = String(promptValue || "").trim();
    const workspace = currentWorkspaceTarget();
    if (
      state.slashCommandsLoaded === true &&
      String(state.slashCommandsWorkspace || "") &&
      String(state.slashCommandsWorkspace || "") !== workspace
    ) {
      state.slashCommandsLoaded = false;
      state.slashCommands = [];
    }
    if (trimmedPrompt !== "/review" && specialMenuOpen()) {
      resetSpecialMenu();
    }
    if (!promptHasFocus()) {
      hideSlashCommandMenu();
      return;
    }
    if (trimmedPrompt === "/review") {
      if (!specialMenuOpen()) setSpecialMenuMode("review-presets");
      warmReviewOptions();
      state.slashMenuOpen = true;
      state.slashMenuItems = [];
      state.slashMenuContextKey = "special:review";
      renderSlashMenu({ focusSpecialInput: specialMenu.mode !== "review-presets" });
      return;
    }
    const context = resolveSlashMenuContext(state.slashCommands, promptValue);
    const shouldOpen = shouldOpenSlashMenu(promptValue, state.slashCommands);
    const items = shouldOpen ? context.items : [];
    const nextContextKey = shouldOpen ? slashMenuContextKey(promptValue, context) : "";
    const contextChanged = nextContextKey !== String(state.slashMenuContextKey || "");
    state.slashMenuOpen = shouldOpen;
    state.slashMenuItems = items;
    state.slashMenuContextKey = nextContextKey;
    if (!items.length || contextChanged) {
      state.slashMenuSelectedIndex = 0;
      state.slashMenuSelectionVisible = false;
    } else {
      state.slashMenuSelectedIndex = Math.max(
        0,
        Math.min(items.length - 1, Number(state.slashMenuSelectedIndex || 0))
      );
    }
    renderSlashMenu();
    if (shouldOpen && state.slashCommandsLoaded !== true && state.slashCommandsLoading !== true) {
      refreshSlashCommands().catch(() => {});
    }
  }

  function moveSlashCommandSelection(delta) {
    const items = specialMenuOpen()
      ? filteredSpecialItems()
      : (Array.isArray(state.slashMenuItems) ? state.slashMenuItems : []);
    if (!state.slashMenuOpen || !items.length) return false;
    const current = Math.max(0, Math.min(items.length - 1, Number(state.slashMenuSelectedIndex || 0)));
    const next = (current + delta + items.length) % items.length;
    state.slashMenuSelectedIndex = next;
    state.slashMenuSelectionVisible = true;
    renderSlashMenu({ revealSelection: true, focusSpecialInput: specialMenu.mode === "review-custom" || specialMenu.mode === "review-branches" || specialMenu.mode === "review-commits" });
    return true;
  }

  function navigateBackSlashMenu() {
    const input = byId("mobilePromptInput");
    if (!input) return false;
    if (specialMenuOpen()) {
      if (specialMenu.mode === "review-presets") {
        input.value = "/";
        updateMobileComposerState();
        resetSpecialMenu();
        try {
          const end = String(input.value || "").length;
          input.focus?.();
          input.setSelectionRange?.(end, end);
        } catch {}
        syncSlashCommandMenu();
        return true;
      }
      setSpecialMenuMode("review-presets");
      renderSlashMenu();
      return true;
    }
    const context = currentMenuContext();
    if (!context.parent) {
      hideSlashCommandMenu();
      return true;
    }
    input.value = "/";
    updateMobileComposerState();
    try {
      const end = String(input.value || "").length;
      input.focus?.();
      input.setSelectionRange?.(end, end);
    } catch {}
    syncSlashCommandMenu();
    return true;
  }

  function applyReviewSelection() {
    const input = byId("mobilePromptInput");
    const item = selectedCommand();
    if (!input) return false;
    if (specialMenu.mode === "review-presets") {
      const action = String(item?.action || "");
      if (action === "uncommitted") {
        input.value = "/review uncommitted";
        updateMobileComposerState();
        hideSlashCommandMenu();
        return true;
      }
      if (action === "base-branch") {
        loadReviewOptions("review-branches").catch(() => {});
        return true;
      }
      if (action === "commit") {
        loadReviewOptions("review-commits").catch(() => {});
        return true;
      }
      if (action === "custom") {
        setSpecialMenuMode("review-custom", { draft: "" });
        renderSlashMenu({ focusSpecialInput: true });
        return true;
      }
      return false;
    }
    if (specialMenu.mode === "review-branches") {
      if (!item?.value) return false;
      input.value = `/review base-branch ${item.value}`;
      updateMobileComposerState();
      hideSlashCommandMenu();
      return true;
    }
    if (specialMenu.mode === "review-commits") {
      if (!item?.value) return false;
      input.value = `/review commit ${item.value}`;
      updateMobileComposerState();
      hideSlashCommandMenu();
      return true;
    }
    if (specialMenu.mode === "review-custom") {
      const draft = String(specialMenu.draft || "").trim();
      if (!draft) return false;
      input.value = `/review custom ${draft}`;
      updateMobileComposerState();
      hideSlashCommandMenu();
      return true;
    }
    return false;
  }

  function applySelectedSlashCommand() {
    if (specialMenuOpen()) return applyReviewSelection();
    const input = byId("mobilePromptInput");
    const item = selectedCommand();
    if (!input || !item) return false;
    const context = currentMenuContext();
    if (context.parent && isSelectionCommandParent(context.parent) && !(Array.isArray(item.children) && item.children.length > 0)) {
      executeSlashCommand(item.command).catch((error) => {
        setStatus(error?.message || `Failed to execute ${item.command}`, true);
      });
      return true;
    }
    input.value = item.insertText;
    updateMobileComposerState();
    if (item.command === "/review") {
      setSpecialMenuMode("review-presets");
      syncSlashCommandMenu();
    } else if (Array.isArray(item.children) && item.children.length > 0) {
      syncSlashCommandMenu();
    } else {
      hideSlashCommandMenu();
    }
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
      return navigateBackSlashMenu();
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
