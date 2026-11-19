const INVERT_TONE = 'invert(1) hue-rotate(180deg)';
const WHITE = [255, 255, 255, 1];
const CLEAR = [0, 0, 0, 0];
const LAUNCHER_LABEL = '切换最新楼层小剧场的亮暗色';
const MEDIA = 'img, video, canvas, object, embed';
const INLINE_BLOCKS = 'div, section, article, aside, main, header, footer, details, blockquote, table, p, ul, ol';
let colorReader;

function parseColor(value, cache) {
    if (!cache.has(value)) {
        colorReader ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
            .getContext('2d', { willReadFrequently: true });
        colorReader.clearRect(0, 0, 1, 1);
        colorReader.fillStyle = 'transparent';
        colorReader.fillStyle = value;
        colorReader.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = colorReader.getImageData(0, 0, 1, 1).data;
        cache.set(value, [r, g, b, a / 255]);
    }
    return cache.get(value);
}

function composite(top, bottom) {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (!alpha) return CLEAR;
    const rgb = top.slice(0, 3).map((channel, i) => (
        channel * top[3] + bottom[i] * bottom[3] * (1 - top[3])
    ) / alpha);
    return [...rgb, alpha];
}

function luminance([r, g, b]) {
    const linear = [r, g, b].map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function getPaint(style, cache) {
    const background = parseColor(style.backgroundColor, cache);
    if (!style.backgroundImage.includes('gradient(')) return background;

    // Computed CSS expresses gradient stops as color functions or transparent.
    const stops = style.backgroundImage.match(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\btransparent\b/gi);
    if (!stops?.length) return background;
    const colors = stops.map(stop => composite(parseColor(stop, cache), background));
    return CLEAR.map((_, i) => colors.reduce((sum, color) => sum + color[i], 0) / colors.length);
}

function getBox(element) {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height, area: width * height };
}

function getBackdrop(element, cache) {
    let color = CLEAR;
    for (let parent = element.parentElement; parent && color[3] < 1; parent = parent.parentElement) {
        color = composite(color, getPaint(getComputedStyle(parent), cache));
    }
    return composite(color, WHITE);
}

function getFrameDocument(frame) {
    try {
        const doc = frame.contentDocument;
        const awaitsSource = frame.hasAttribute('srcdoc') || !['', 'about:blank'].includes(frame.getAttribute('src') ?? '');
        return doc?.body && (!awaitsSource || doc.URL !== 'about:blank') ? doc : null;
    } catch {
        return null;
    }
}

function readTone(element, doc, box, cache) {
    const backdrop = getBackdrop(element, cache);
    const root = doc?.body ?? element;
    const view = root.ownerDocument.defaultView;
    const framePaint = doc ? getPaint(getComputedStyle(element), cache) : CLEAR;
    const pagePaint = doc ? composite(getPaint(view.getComputedStyle(doc.documentElement), cache), framePaint) : CLEAR;
    const rootPaint = getPaint(view.getComputedStyle(root), cache);
    const base = composite(rootPaint, composite(pagePaint, backdrop));
    const area = doc ? { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight } : box;
    const regions = [];

    for (const child of root.querySelectorAll('*')) {
        if (child.namespaceURI !== 'http://www.w3.org/1999/xhtml' || child.matches(MEDIA)) continue;
        const style = view.getComputedStyle(child);
        if (style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
        const paint = getPaint(style, cache);
        if (!paint[3]) continue;
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        regions.push({ rect, paint });
    }

    let lightPoints = 0;
    const grid = 5;
    for (let row = 0; row < grid; row++) {
        for (let col = 0; col < grid; col++) {
            const x = area.left + area.width * (col + 0.5) / grid;
            const y = area.top + area.height * (row + 0.5) / grid;
            let color = base;
            for (const { rect, paint } of regions) {
                if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
                    color = composite(paint, color);
                }
            }
            // The light/dark boundary corresponds to middle gray in sRGB.
            if (luminance(color) >= 0.215) lightPoints++;
        }
    }

    return { element, doc, backdrop, lightShare: lightPoints / (grid * grid), weight: box.area };
}

function inspect(message) {
    const cache = new Map();
    const results = [];
    let unreadableFrames = 0;

    for (const frame of message.querySelectorAll('iframe')) {
        const box = getBox(frame);
        if (!box.area || getComputedStyle(frame).visibility !== 'visible') continue;
        const doc = getFrameDocument(frame);
        if (doc) results.push(readTone(frame, doc, box, cache));
        else unreadableFrames++;
    }

    const containers = new Set();
    for (const element of message.querySelectorAll(INLINE_BLOCKS)) {
        if (element.closest('pre, code') || element.querySelector('iframe')) continue;
        let ancestor = element.parentElement;
        while (ancestor !== message && !containers.has(ancestor)) ancestor = ancestor.parentElement;
        if (containers.has(ancestor)) continue;
        const style = getComputedStyle(element);
        const painted = getPaint(style, cache)[3] > 0 || style.backgroundImage !== 'none';
        if (!(painted || element.style.color) || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
        const box = getBox(element);
        if (box.width < 24 || box.height < 12) continue;
        containers.add(element);
        results.push(readTone(element, null, box, cache));
    }

    return { results, unreadableFrames };
}

function setTemporaryStyle(element, property, value, undo) {
    const previous = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority(property);
    const hadStyle = element.hasAttribute('style');
    element.style.setProperty(property, value, 'important');
    const applied = element.style.getPropertyValue(property);
    undo.push(() => {
        if (element.style.getPropertyValue(property) !== applied || element.style.getPropertyPriority(property) !== 'important') return;
        if (previous) element.style.setProperty(property, previous, priority);
        else element.style.removeProperty(property);
        if (!hadStyle && !element.style.length) element.removeAttribute('style');
    });
}

function invertTarget({ element, doc, backdrop }, undo) {
    const { filter, backgroundColor } = getComputedStyle(element);
    const color = parseColor(backgroundColor, new Map());
    if (color[3] < 1) {
        const [r, g, b] = composite(color, backdrop).map(Math.round);
        setTemporaryStyle(element, 'background-color', `rgb(${r}, ${g}, ${b})`, undo);
    }
    setTemporaryStyle(element, 'filter', filter === 'none' ? INVERT_TONE : `${filter} ${INVERT_TONE}`, undo);

    const root = doc?.body ?? element;
    for (const media of root.querySelectorAll(MEDIA)) {
        if (media.parentElement?.closest(MEDIA)) continue;
        const original = root.ownerDocument.defaultView.getComputedStyle(media).filter;
        setTemporaryStyle(media, 'filter', original === 'none' ? INVERT_TONE : `${original} ${INVERT_TONE}`, undo);
    }
}

function currentFloor() {
    const context = globalThis.SillyTavern?.getContext?.();
    const id = context?.getCurrentChatId?.() ?? context?.chatId;
    const index = (context?.chat?.length ?? 0) - 1;
    if (id == null || index < 0) return null;
    const chat = document.getElementById('chat');
    const row = chat?.querySelector(`:scope > .mes[mesid="${index}"]`);
    const content = row?.querySelector('.mes_text');
    const message = context.chat[index];
    if (!content || !message) return null;
    const character = context.characters?.[context.characterId];
    const key = JSON.stringify([context.groupId, context.characterId, character?.avatar, id]);
    return { key, index, chat, content, message, swipe: message.swipe_id };
}

function createControls() {
    const widget = document.createElement('div');
    widget.id = 'theater-tone';
    widget.innerHTML = `
        <span role="status"></span>
        <button class="theater-tone-button" type="button" aria-label="${LAUNCHER_LABEL}" aria-pressed="false" title="${LAUNCHER_LABEL}">◐</button>
    `;
    const status = widget.querySelector('[role="status"]');
    const button = widget.querySelector('button');

    const settings = document.createElement('div');
    settings.id = 'theater-tone-settings';
    settings.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>小剧场换色</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <button type="button" class="menu_button">立即换色</button>
                <p role="status">已就绪</p>
            </div>
        </div>
    `;
    const settingsButton = settings.querySelector('button');
    const settingsStatus = settings.querySelector('[role="status"]');

    let active = null;
    let timeout;
    const observer = new MutationObserver(checkFloor);
    const subscribedEvents = new WeakSet();
    const unsubscribe = [];

    function announce(message) {
        clearTimeout(timeout);
        status.textContent = message;
        settingsStatus.textContent = message || '已就绪';
        if (message) timeout = setTimeout(() => { status.textContent = ''; }, 3600);
    }

    function reset() {
        if (!active) return;
        observer.disconnect();
        for (const restore of active.undo.reverse()) restore();
        active = null;
        delete widget.dataset.tone;
        button.setAttribute('aria-pressed', 'false');
        button.title = LAUNCHER_LABEL;
        settingsButton.textContent = '立即换色';
        announce('');
    }

    function checkFloor() {
        if (!active) return;
        const floor = currentFloor();
        if (!floor || ['key', 'index', 'content', 'message', 'swipe'].some(key => floor[key] !== active.floor[key])
            || active.targets.some(({ element, doc }) => !floor.content.contains(element) || (doc && getFrameDocument(element) !== doc))) {
            reset();
        }
    }

    function toggleTone() {
        checkFloor();
        if (active) {
            reset();
            announce('已恢复最新楼层原色');
            return;
        }

        const floor = currentFloor();
        if (!floor) {
            announce('当前存档没有可改色的楼层');
            return;
        }
        const { results, unreadableFrames } = inspect(floor.content);
        if (!results.length) {
            if (floor.content.querySelector('details:not([open])')) announce('先展开最新楼层的小剧场，再点一次');
            else announce(unreadableFrames ? '最新楼层的前端尚未加载或无法读取' : '最新楼层没有可改色的 HTML');
            return;
        }

        const light = results.reduce((sum, target) => sum + target.lightShare * target.weight, 0);
        const total = results.reduce((sum, target) => sum + target.weight, 0);
        const wasLight = light >= total / 2;
        subscribeToChatEvents();
        active = { floor, targets: results, undo: [] };
        observer.observe(floor.chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid', 'src', 'srcdoc'] });
        for (const target of results) {
            if ((target.lightShare >= 0.5) === wasLight) invertTarget(target, active.undo);
            if (target.doc) {
                const onLoad = () => {
                    if (getFrameDocument(target.element) !== target.doc) reset();
                };
                target.element.addEventListener('load', onLoad);
                active.undo.push(() => target.element.removeEventListener('load', onLoad));
            }
        }

        widget.dataset.tone = wasLight ? 'dark' : 'light';
        button.setAttribute('aria-pressed', 'true');
        button.title = '恢复最新楼层原色';
        settingsButton.textContent = '恢复原色';
        announce(`已切换为${wasLight ? '暗' : '亮'}色系${unreadableFrames ? '（部分前端无法读取）' : ''}`);
    }

    function subscribeToChatEvents() {
        const { eventSource, eventTypes, event_types } = globalThis.SillyTavern?.getContext?.() ?? {};
        const types = eventTypes ?? event_types;
        if (!eventSource?.on || !types || subscribedEvents.has(eventSource)) return;
        subscribedEvents.add(eventSource);
        const on = (name, handler) => {
            if (!types[name]) return;
            eventSource.on(types[name], handler);
            unsubscribe.push(() => eventSource.off?.(types[name], handler));
        };
        for (const event of ['CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED']) {
            on(event, reset);
        }
        for (const event of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
            on(event, id => {
                if (active && Number(id) === active.floor.index) reset();
            });
        }
    }

    button.addEventListener('click', toggleTone);
    settingsButton.addEventListener('click', toggleTone);
    return {
        mount() {
            if (!widget.isConnected) document.body.append(widget);
            if (!settings.isConnected) document.getElementById('extensions_settings2')?.append(settings);
        },
        dispose() {
            reset();
            clearTimeout(timeout);
            unsubscribe.forEach(off => off());
            widget.remove();
            settings.remove();
        },
    };
}

let controls;
let deactivated = false;

export function activate() {
    if (deactivated || !document.body) return;
    controls ??= createControls();
    controls.mount();
}

export function deactivate() {
    deactivated = true;
    controls?.dispose();
    controls = undefined;
}

const { eventSource, eventTypes, event_types } = globalThis.SillyTavern?.getContext?.() ?? {};
const types = eventTypes ?? event_types;
for (const name of ['APP_INITIALIZED', 'APP_READY']) {
    if (types?.[name]) eventSource?.on(types[name], activate);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', activate, { once: true });
else activate();
