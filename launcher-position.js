const STORAGE_KEY = 'theater-tone:launcher-position';
const DEFAULT_POSITION = { side: 'right', ratio: null };
const DRAG_DISTANCE = 7;
const EDGE_GAP = 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readPosition() {
    try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (value && ['left', 'right'].includes(value.side) && Number.isFinite(value.ratio)) {
            return { side: value.side, ratio: clamp(value.ratio, 0, 1) };
        }
    } catch {
        // The position can still be changed for this page when storage is unavailable.
    }
    return { ...DEFAULT_POSITION };
}

export function positionLauncher(widget, button, moveButton, resetButton) {
    const events = new AbortController();
    const { signal } = events;
    const view = window.visualViewport;
    let position = readPosition();
    let drag;
    let skipClick = false;
    let frame;

    function bounds() {
        const style = getComputedStyle(widget);
        const inset = side => Number.parseFloat(style.getPropertyValue(`--theater-tone-inset-${side}`)) || 0;
        const diameter = button.offsetWidth || 44;
        const offsetX = view?.offsetLeft ?? 0;
        const offsetY = view?.offsetTop ?? 0;
        const width = view?.width ?? window.innerWidth;
        const height = view?.height ?? window.innerHeight;
        const topBar = document.getElementById('top-bar')?.getBoundingClientRect();
        const composer = document.getElementById('form_sheld')?.getBoundingClientRect();
        const top = Math.max(offsetY + Math.max(EDGE_GAP, inset('top')), topBar?.bottom ?? 0);
        const bottom = Math.min(offsetY + height - inset('bottom'), composer?.height ? composer.top : Infinity);
        const left = offsetX + Math.max(EDGE_GAP, inset('left'));
        return {
            left,
            right: Math.max(left, offsetX + width - diameter - Math.max(EDGE_GAP, inset('right'))),
            top: Math.min(top + EDGE_GAP, Math.max(offsetY, bottom - diameter - EDGE_GAP)),
            bottom: Math.max(offsetY, bottom - diameter - EDGE_GAP),
        };
    }

    function place(x, y, side) {
        widget.style.setProperty('--theater-tone-left', `${Math.round(x)}px`);
        widget.style.setProperty('--theater-tone-top', `${Math.round(y)}px`);
        widget.dataset.side = side;
    }

    function layout() {
        if (drag?.moved) return;
        const area = bounds();
        const y = position.ratio === null
            ? Math.max(area.top, area.bottom - 66)
            : area.top + (area.bottom - area.top) * position.ratio;
        place(area[position.side], y, position.side);
        moveButton.textContent = position.side === 'left' ? '移到右侧' : '移到左侧';
    }

    function schedule() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(layout);
    }

    function save() {
        try {
            if (position.ratio === null && position.side === 'right') localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
        } catch {
            // Keeping the placement in memory is sufficient for the current page.
        }
        layout();
    }

    function move(event) {
        if (drag?.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_DISTANCE) return;
        drag.moved = true;
        widget.dataset.dragging = '';
        const { left, right, top, bottom } = drag.area;
        drag.x = clamp(drag.originX + dx, left, right);
        drag.y = clamp(drag.originY + dy, top, bottom);
        place(drag.x, drag.y, widget.dataset.side);
    }

    function end(event) {
        if (drag?.id !== event.pointerId) return;
        const previous = drag;
        drag = undefined;
        delete widget.dataset.dragging;
        if (!previous.moved) return;
        skipClick = true;
        if (event.type !== 'pointerup') {
            layout();
            return;
        }
        const { left, right, top, bottom } = previous.area;
        position = {
            side: previous.x < (left + right) / 2 ? 'left' : 'right',
            ratio: (previous.y - top) / Math.max(1, bottom - top),
        };
        save();
    }

    button.addEventListener('pointerdown', event => {
        if (drag || !event.isPrimary || event.button !== 0) return;
        skipClick = false;
        const { left, top } = widget.getBoundingClientRect();
        drag = {
            id: event.pointerId,
            startX: event.clientX, startY: event.clientY,
            originX: left, originY: top,
            area: bounds(),
            moved: false,
        };
        button.setPointerCapture(event.pointerId);
    }, { signal });
    button.addEventListener('pointermove', move, { signal });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        button.addEventListener(event, end, { signal });
    }
    button.addEventListener('click', event => {
        if (!skipClick || !event.detail) return;
        skipClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, { capture: true, signal });
    moveButton.addEventListener('click', () => {
        const area = bounds();
        const y = widget.getBoundingClientRect().top;
        position = {
            side: position.side === 'left' ? 'right' : 'left',
            ratio: clamp((y - area.top) / Math.max(1, area.bottom - area.top), 0, 1),
        };
        save();
    }, { signal });
    resetButton.addEventListener('click', () => {
        position = { ...DEFAULT_POSITION };
        save();
    }, { signal });
    window.addEventListener('resize', schedule, { signal });
    view?.addEventListener('resize', schedule, { signal });
    view?.addEventListener('scroll', schedule, { signal });
    const resize = new ResizeObserver(schedule);
    resize.observe(button);
    for (const id of ['top-bar', 'form_sheld']) {
        const element = document.getElementById(id);
        if (element) resize.observe(element);
    }
    layout();
    return () => {
        events.abort();
        resize.disconnect();
        cancelAnimationFrame(frame);
    };
}
