export function chatDistanceFromMetrics(scrollHeight, scrollTop, clientHeight) {
  return Math.max(
    0,
    Number(scrollHeight || 0) - (Number(scrollTop || 0) + Number(clientHeight || 0))
  );
}

export function isNearBottomForJumpButton(
  scrollHeight,
  scrollTop,
  clientHeight,
  threshold = 180
) {
  return (
    chatDistanceFromMetrics(scrollHeight, scrollTop, clientHeight) <=
    Math.max(0, Number(threshold || 0))
  );
}

export function createChatViewportModule(deps) {
  const {
    state,
    byId,
    dbgSet,
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame,
    cancelAnimationFrameRef = cancelAnimationFrame,
    CHAT_LIVE_FOLLOW_MAX_STEP_PX,
    CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS,
  } = deps;

  function isChatNearBottom() {
    const box = byId("chatBox");
    if (!box) return true;
    return chatDistanceFromMetrics(box.scrollHeight, box.scrollTop, box.clientHeight) <= 80;
  }

  function chatDistanceFromBottom(box) {
    if (!box) return 0;
    return chatDistanceFromMetrics(box.scrollHeight, box.scrollTop, box.clientHeight);
  }

  function isChatNearBottomForJumpBtn() {
    const box = byId("chatBox");
    if (!box) return true;
    return isNearBottomForJumpButton(box.scrollHeight, box.scrollTop, box.clientHeight, 180);
  }

  function updateScrollToBottomBtn() {
    const box = byId("chatBox");
    if (!box) return;
    const btn = ensureScrollToBottomBtn();
    if (!btn) return;
    positionScrollToBottomBtn(btn, box);
    const show =
      box.scrollHeight > box.clientHeight + 40 &&
      (!state.chatShouldStickToBottom || !isChatNearBottomForJumpBtn());
    btn.classList.toggle("show", !!show);
    btn.setAttribute("aria-hidden", show ? "false" : "true");
    if (!show) {
      btn.disabled = true;
      btn.tabIndex = -1;
      try {
        if (documentRef.activeElement === btn) btn.blur();
      } catch {}
    } else {
      btn.disabled = false;
      btn.tabIndex = 0;
    }
  }

  function scrollChatToBottom({ force = false } = {}) {
    const box = byId("chatBox");
    if (!box) return;
    if (!force && !state.chatShouldStickToBottom) return;
    const wasSticky = !!state.chatShouldStickToBottom;
    state.chatShouldStickToBottom = true;
    if (force) state.chatUserScrolledAwayAt = 0;
    state.chatProgrammaticScrollUntil = Date.now() + 260;
    if (force && !wasSticky) {
      dbgSet({
        lastForceScrollWhileNotStickyAt: Date.now(),
        lastForceScrollWhileNotStickyGestureAgoMs:
          Date.now() - Number(state.chatLastUserGestureAt || 0),
      });
    }
    dbgSet({
      lastScrollChatToBottomAt: Date.now(),
      lastScrollChatToBottomForce: !!force,
    });
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    updateScrollToBottomBtn();
  }

  function scrollToBottomReliable() {
    const token = (Number(state.chatReconcileToken || 0) + 1) | 0;
    state.chatReconcileToken = token;
    const startedAt = Date.now();
    let lastKey = "";
    let stableFrames = 0;
    scrollChatToBottom({ force: true });

    const tick = () => {
      if (token !== state.chatReconcileToken) return;
      if (!state.chatShouldStickToBottom) return;
      const box = byId("chatBox");
      if (!box) return;
      const now = Date.now();
      if (now - startedAt > 2200) return;
      if (now - Number(state.chatLastUserGestureAt || 0) <= 120) return;

      const targetTop = Math.max(0, box.scrollHeight - box.clientHeight);
      const dist = targetTop - box.scrollTop;
      if (dist > 0.5) scrollChatToBottom({ force: true });

      const key = `${Math.round(box.scrollHeight)}:${Math.round(box.clientHeight)}:${Math.round(
        box.scrollTop
      )}`;
      if (key === lastKey && dist <= 0.5) stableFrames += 1;
      else stableFrames = 0;
      lastKey = key;
      if (stableFrames >= 8) return;
      requestAnimationFrameRef(tick);
    };

    requestAnimationFrameRef(tick);
  }

  function canStartChatLiveFollow() {
    const now = Date.now();
    if (now <= Number(state.chatSmoothScrollUntil || 0)) return false;
    if (state.chatShouldStickToBottom) return true;
    if (!Number(state.chatUserScrolledAwayAt || 0)) return isChatNearBottom();
    if (isChatNearBottom() && now - Number(state.chatUserScrolledAwayAt || 0) >= 900) {
      return true;
    }
    return false;
  }

  function stopChatLiveFollow() {
    state.chatLiveFollowUntil = 0;
    state.chatLiveFollowToken = (Number(state.chatLiveFollowToken || 0) + 1) | 0;
    if (state.chatLiveFollowRaf) {
      try {
        cancelAnimationFrameRef(state.chatLiveFollowRaf);
      } catch {}
      state.chatLiveFollowRaf = 0;
    }
  }

  function scheduleChatLiveFollow(extraMs = 520) {
    const box = byId("chatBox");
    if (!box) return;
    const now = Date.now();
    const alreadyFollowing = now <= Number(state.chatLiveFollowUntil || 0);
    if (!alreadyFollowing) {
      if (
        !state.chatShouldStickToBottom &&
        Number(state.chatUserScrolledAwayAt || 0) &&
        isChatNearBottom() &&
        now - Number(state.chatUserScrolledAwayAt || 0) >= 900
      ) {
        state.chatShouldStickToBottom = true;
        state.chatUserScrolledAwayAt = 0;
      }
      if (!canStartChatLiveFollow()) return;
    }
    state.chatLiveFollowUntil = Math.max(
      Number(state.chatLiveFollowUntil || 0),
      now + Math.max(0, Number(extraMs || 0))
    );
    if (state.chatLiveFollowRaf) return;

    state.chatLiveFollowToken = (Number(state.chatLiveFollowToken || 0) + 1) | 0;
    const token = state.chatLiveFollowToken;
    const step = () => {
      state.chatLiveFollowRaf = 0;
      if (token !== state.chatLiveFollowToken) return;
      const now2 = Date.now();
      if (now2 > Number(state.chatLiveFollowUntil || 0)) return;
      if (now2 <= Number(state.chatSmoothScrollUntil || 0)) return;

      const targetTop = Math.max(0, box.scrollHeight - box.clientHeight);
      const dist = targetTop - box.scrollTop;
      if (dist <= 0.5) {
        if (
          now2 - Number(state.chatLiveFollowLastBtnMs || 0) >=
          CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS
        ) {
          state.chatLiveFollowLastBtnMs = now2;
          updateScrollToBottomBtn();
        }
        state.chatLiveFollowRaf = requestAnimationFrameRef(step);
        return;
      }

      const rawStep = Math.max(1, dist * 0.22);
      const maxStep = Math.min(
        CHAT_LIVE_FOLLOW_MAX_STEP_PX,
        Math.max(10, dist * 0.35)
      );
      const delta = Math.min(rawStep, maxStep);
      state.chatProgrammaticScrollUntil = now2 + 160;
      box.scrollTop += delta;

      if (
        now2 - Number(state.chatLiveFollowLastBtnMs || 0) >=
        CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS
      ) {
        state.chatLiveFollowLastBtnMs = now2;
        updateScrollToBottomBtn();
      }
      state.chatLiveFollowRaf = requestAnimationFrameRef(step);
    };
    state.chatLiveFollowRaf = requestAnimationFrameRef(step);
  }

  function smoothScrollChatToBottom(durationMs = undefined) {
    const box = byId("chatBox");
    if (!box) return;
    const prefersReduced =
      typeof windowRef !== "undefined" &&
      typeof windowRef.matchMedia === "function" &&
      windowRef.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const startTop = box.scrollTop;
    const initialTargetTop = Math.max(0, box.scrollHeight - box.clientHeight);
    if (initialTargetTop <= startTop + 1) return;
    const distancePx = Math.max(0, initialTargetTop - startTop);
    const computedDuration = prefersReduced
      ? Math.round(Math.max(400, Math.min(520, 80 + Math.sqrt(distancePx) * 18)))
      : Math.round(Math.max(420, Math.min(1400, 100 + Math.sqrt(distancePx) * 24)));
    const dur =
      durationMs == null || !Number.isFinite(Number(durationMs))
        ? computedDuration
        : Math.max(1, Math.round(Number(durationMs)));

    let startedAt = null;
    state.chatSmoothScrollToken = (Number(state.chatSmoothScrollToken || 0) + 1) | 0;
    const token = state.chatSmoothScrollToken;
    state.chatSmoothScrollUntil = Date.now() + Math.max(0, dur + 250);
    stopChatLiveFollow();
    dbgSet({
      lastSmoothScrollStartAt: Date.now(),
      lastSmoothScrollDurMs: dur,
      lastSmoothScrollStartTop: startTop,
      lastSmoothScrollInitialTargetTop: initialTargetTop,
    });

    let sampledTargetTop = initialTargetTop;
    let lastSampleMs = 0;
    let lastBtnUpdateMs = 0;
    const tail = [];
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      if (token !== state.chatSmoothScrollToken) return;
      if (startedAt == null) startedAt = now;
      const t = Math.min(1, (now - startedAt) / Math.max(1, dur));
      const eased = easeOutCubic(t);
      if (now - lastSampleMs >= 90) {
        lastSampleMs = now;
        sampledTargetTop = Math.max(0, box.scrollHeight - box.clientHeight);
      }
      box.scrollTop = startTop + (sampledTargetTop - startTop) * eased;
      tail.push(box.scrollTop);
      while (tail.length > 10) tail.shift();
      if (t === 0) {
        dbgSet({
          lastSmoothScrollFirstFrameAt: Date.now(),
          lastSmoothScrollFirstFrameTop: box.scrollTop,
        });
      }
      if (now - lastBtnUpdateMs >= 66) {
        lastBtnUpdateMs = now;
        updateScrollToBottomBtn();
      }
      if (t < 1) {
        requestAnimationFrameRef(step);
        return;
      }
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
      updateScrollToBottomBtn();
      dbgSet({
        lastSmoothScrollEndedAt: Date.now(),
        lastSmoothScrollEndedTop: box.scrollTop,
        lastSmoothScrollTail: tail.slice(),
      });
      if (token === state.chatSmoothScrollToken) state.chatSmoothScrollUntil = 0;
    };
    requestAnimationFrameRef(step);
  }

  function ensureScrollToBottomBtn() {
    const box = byId("chatBox");
    if (!box) return null;
    const btn = byId("scrollToBottomBtn");
    if (!btn) return null;
    if (!btn.__wired) {
      btn.__wired = true;
      btn.onclick = () => {
        smoothScrollChatToBottom();
        updateScrollToBottomBtn();
      };
    }
    const panel = box.parentElement || box;
    if (btn.parentElement !== panel) panel.appendChild(btn);
    positionScrollToBottomBtn(btn, box);
    return btn;
  }

  function positionScrollToBottomBtn(btn, box) {
    if (!btn || !box) return;
    const panel = box.parentElement || null;
    const panelRect = panel?.getBoundingClientRect?.();
    const chatRect = box.getBoundingClientRect?.();
    const panelBottom = Number(panelRect?.bottom);
    const chatBottom = Number(chatRect?.bottom);
    const overlayBottomPx =
      Number.isFinite(panelBottom) && Number.isFinite(chatBottom)
        ? Math.max(12, Math.round(panelBottom - chatBottom + 12))
        : 12;
    btn.style.bottom = `${overlayBottomPx}px`;
  }

  return {
    canStartChatLiveFollow,
    chatDistanceFromBottom,
    ensureScrollToBottomBtn,
    isChatNearBottom,
    isChatNearBottomForJumpBtn,
    scheduleChatLiveFollow,
    scrollChatToBottom,
    scrollToBottomReliable,
    smoothScrollChatToBottom,
    stopChatLiveFollow,
    updateScrollToBottomBtn,
  };
}
