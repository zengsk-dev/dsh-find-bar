/**
 * Browser half of the find bar: a `shell.overlay` surface, a rebindable Ctrl+F /
 * Cmd+F command, and a highlight overlay drawn from live DOM text ranges.
 *
 * The page is walked on demand: nothing here observes or mutates host markup.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-find-bar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'findBar';
    const zh = {
      placeholder: '查找关键词',
      next: '下一个 (Enter)',
      prev: '上一个 (Shift+Enter)',
      close: '关闭 (Esc)',
      open: '在页面中查找',
      empty: '无结果',
    };
    const en = {
      placeholder: 'Find in page',
      next: 'Next match (Enter)',
      prev: 'Previous match (Shift+Enter)',
      close: 'Close (Esc)',
      open: 'Find in page',
      empty: 'No results',
    };

    const MAX_MATCHES = 1500;
    const MOUNT_DELAY_MS = 80;
    const SCAN_INTERVAL_MS = 900;
    const SCAN_WINDOW_MS = 12000;

    const HIGHLIGHT_MARKER = 'data-find-bar-highlights';
    const OPT_OUT_MARKER = 'data-find-bar-ignore';
    const BLOCKED_TAGS = new Set([
      'SCRIPT',
      'STYLE',
      'NOSCRIPT',
      'TEMPLATE',
      'TITLE',
      'IFRAME',
      'CANVAS',
      'SVG',
      'TEXTAREA',
      'INPUT',
      'SELECT',
      'OPTION',
    ]);
    const EXCLUDED_CONTAINERS = ['[data-shell-overlay]', '[data-shell-leading]'];

    // ---------------------------------------------------------------- platform

    function platformOf() {
      const raw = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
      return /mac/i.test(raw) ? 'macos' : 'windows';
    }

    function normalize(text) {
      return String(text).replace(/\s+/g, ' ');
    }

    function installStyles() {
      const id = 'dsh-find-bar-styles';
      const previous = document.getElementById(id);
      if (previous) previous.remove();
      const style = document.createElement('style');
      style.id = id;
      style.textContent = [
        '[data-find-bar-highlights]{position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147482000}',
        '[data-find-bar-highlights] .dsh-find-box{position:absolute;border-radius:2px;',
        'background:rgba(255,204,0,.34);box-shadow:0 0 0 1px rgba(255,204,0,.5)}',
        '[data-find-bar-highlights] .dsh-find-box-active{background:rgba(255,138,0,.5);',
        'box-shadow:0 0 0 1px rgba(255,120,0,.85)}',
      ].join('');
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    function icon(d) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, focusable: false },
        h('path', {
          d: d,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      );
    }

    const ICON_UP = 'M4 10l4-4 4 4';
    const ICON_DOWN = 'M4 6l4 4 4-4';
    const ICON_CLOSE = 'M4 4l8 8M12 4l-8 8';

    // ------------------------------------------------------------------ finder

    function createFinder() {
      const slots = [];
      const listeners = new Set();
      let state = null;
      let marker = null;
      let boxLayer = null;
      let disposeStyles = null;
      let disposeListeners = null;
      let raf = 0;
      const scanners = new Set();

      function isExcluded(element) {
        for (const selector of EXCLUDED_CONTAINERS) {
          if (element.closest(selector)) return true;
        }
        return false;
      }

      function isSkipped(node, stop) {
        let element = node.parentElement;
        while (element) {
          if (element.hasAttribute(OPT_OUT_MARKER) || element.hasAttribute('hidden')) return true;
          if (BLOCKED_TAGS.has(element.tagName)) return true;
          if (isExcluded(element)) return true;
          if (element === stop) return false;
          element = element.parentElement;
        }
        return false;
      }

      function walk(start) {
        const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT;
            return isSkipped(node, start) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          },
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return nodes;
      }

      function clearMatches() {
        marker = null;
        state = null;
        if (boxLayer && boxLayer.parentNode) boxLayer.parentNode.removeChild(boxLayer);
        boxLayer = null;
      }

      /**
       * The counter and the arrow buttons read finder state during render, so every
       * mutation has to wake React: searching only repaints the highlight layer.
       */
      function notify() {
        for (const listener of listeners) listener();
      }

      function clearLayer(layer) {
        while (layer.firstChild) layer.removeChild(layer.firstChild);
      }

      function drawBoxes() {
        if (!boxLayer || !state) return;
        clearLayer(boxLayer);
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < state.matches.length; index += 1) {
          const isActive = index === state.active;
          let rects;
          try {
            rects = state.matches[index].range.getClientRects();
          } catch (error) {
            rects = [];
          }
          for (const rect of rects) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            const box = document.createElement('div');
            box.className = isActive ? 'dsh-find-box dsh-find-box-active' : 'dsh-find-box';
            box.style.left = rect.left + 'px';
            box.style.top = rect.top + 'px';
            box.style.width = rect.width + 'px';
            box.style.height = rect.height + 'px';
            fragment.appendChild(box);
          }
        }
        boxLayer.appendChild(fragment);
      }

      function activeElement() {
        if (!state || state.active < 0) return null;
        const match = state.matches[state.active];
        if (!match) return null;
        return match.node.parentElement || match.node.parentNode || null;
      }

      function paint(scroll) {
        if (!state) {
          if (marker) marker.sync();
          return;
        }
        if (!boxLayer) {
          boxLayer = document.createElement('div');
          boxLayer.setAttribute(HIGHLIGHT_MARKER, '');
          boxLayer.setAttribute(OPT_OUT_MARKER, '');
          document.body.appendChild(boxLayer);
        }
        if (scroll === true) {
          const target = activeElement();
          if (target) {
            try {
              target.scrollIntoView({ block: 'center', inline: 'nearest' });
            } catch (error) {
              target.scrollIntoView();
            }
          }
        }
        drawBoxes();
        if (marker) marker.sync();
      }

      function schedulePaint() {
        if (raf !== 0) return;
        const run = () => {
          raf = 0;
          paint(false);
        };
        raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
      }

      function onViewportChanged() {
        schedulePaint();
      }

      function search(rawQuery) {
        clearMatches();
        const query = normalize(rawQuery);
        if (query.trim().length === 0) {
          notify();
          stopScanners();
          return;
        }
        const needle = query.toLowerCase();
        const found = [];
        outer: for (const slot of slots) {
          if (!slot.isConnected) continue;
          for (const node of walk(slot)) {
            const haystack = normalize(node.nodeValue).toLowerCase();
            if (haystack.indexOf(needle) === -1) continue;
            let from = 0;
            for (;;) {
              const at = haystack.indexOf(needle, from);
              if (at === -1) break;
              try {
                const range = document.createRange();
                range.setStart(node, Math.min(at, node.nodeValue.length));
                range.setEnd(node, Math.min(at + query.length, node.nodeValue.length));
                found.push({ node: node, range: range });
              } catch (error) {
                break;
              }
              if (found.length >= MAX_MATCHES) break outer;
              from = at + needle.length;
            }
          }
        }
        state = { matches: found, active: found.length === 0 ? -1 : 0 };
        paint(true);
        notify();
      }

      function stopScanners() {
        for (const scanner of scanners) clearInterval(scanner);
        scanners.clear();
      }

      function open() {
        if (disposeStyles === null) disposeStyles = installStyles();
        if (disposeListeners === null) {
          window.addEventListener('scroll', onViewportChanged, true);
          window.addEventListener('resize', onViewportChanged, true);
          disposeListeners = () => {
            window.removeEventListener('scroll', onViewportChanged, true);
            window.removeEventListener('resize', onViewportChanged, true);
          };
        }
        stopScanners();
        // Content keeps arriving while the bar is open (streaming answers, image
        // loads, lazy lists); re-anchor the highlight boxes for a short while.
        const tick = setInterval(() => {
          paint(false);
        }, SCAN_INTERVAL_MS);
        scanners.add(tick);
        setTimeout(() => {
          if (scanners.delete(tick)) clearInterval(tick);
        }, SCAN_WINDOW_MS);
      }

      function close() {
        stopScanners();
        if (raf !== 0) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
          else clearTimeout(raf);
          raf = 0;
        }
        clearMatches();
        if (disposeListeners) {
          disposeListeners();
          disposeListeners = null;
        }
        if (disposeStyles) {
          disposeStyles();
          disposeStyles = null;
        }
      }

      return {
        register(root) {
          const slot = root || document.body;
          if (slots.indexOf(slot) !== -1) return () => {};
          slots.push(slot);
          return () => {
            const index = slots.indexOf(slot);
            if (index === -1) return;
            slots.splice(index, 1);
            if (slots.length === 0) close();
          };
        },
        open: open,
        close: close,
        search: search,
        step(delta) {
          if (!state || state.matches.length === 0) return;
          const total = state.matches.length;
          state.active = ((state.active + delta) % total + total) % total;
          paint(true);
          notify();
        },
        status() {
          if (!state) return '';
          if (state.matches.length === 0) return 'empty';
          return state.active + 1 + '/' + state.matches.length;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        isOpen() {
          return disposeStyles !== null;
        },
        dispose: close,
      };
    }

    // --------------------------------------------------------------- component

    function FindBar(props) {
      const finder = props.finder;
      const t = props.t;
      const inputRef = React.useRef(null);
      const [value, setValue] = React.useState('');
      const [open, setOpen] = React.useState(() => props.isOpen());
      const [, setRevision] = React.useState(0);

      React.useEffect(() => props.subscribe(setOpen), []);

      // Search results are imperative state on the finder; re-render whenever they
      // change so the counter and the disabled arrows never describe an older query.
      React.useEffect(() => finder.subscribe(() => setRevision((revision) => revision + 1)), []);

      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => {
          const input = inputRef.current;
          if (input) {
            input.focus();
            input.select();
          }
        }, MOUNT_DELAY_MS);
        return () => {
          clearTimeout(timer);
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const unregister = finder.register(document.body);
        finder.open();
        return () => {
          unregister();
          finder.close();
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        finder.search(value);
        return undefined;
      }, [value, open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open, props.onClose]);

      if (!open) return null;

      const status = finder.status();
      const box = {
        // Fixed to the viewport: the overlay layer is laid out by the frame, so an
        // absolutely positioned child would land in its top-left corner instead.
        position: 'fixed',
        top: '96px',
        right: '20px',
        zIndex: 2147483000,
        maxWidth: 'calc(100vw - 40px)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 8px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.34))',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))',
        color: 'var(--dsw-alias-label-primary, #1f1f1f)',
        boxShadow: '0 10px 30px rgba(0,0,0,.22)',
        font: '13px/1.4 var(--dsw-font, system-ui, -apple-system, "Segoe UI", sans-serif)',
        pointerEvents: 'auto',
      };
      const button = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: 0,
        border: 'none',
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      };
      const stepButton = { ...button, cursor: status === '' || status === 'empty' ? 'default' : 'pointer', opacity: status === '' || status === 'empty' ? 0.38 : 1 };
      const input = {
        width: '210px',
        boxSizing: 'border-box',
        padding: '4px 8px',
        font: 'inherit',
        color: 'inherit',
        background: 'var(--dsw-alias-bg-base, #fff)',
        border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.34))',
        borderRadius: '8px',
        outline: 'none',
      };
      const disabled = status === '' || status === 'empty';

      return h(
        'div',
        { style: box, role: 'search', 'aria-label': t('open') },
        h('input', {
          ref: inputRef,
          style: input,
          type: 'text',
          value: value,
          spellCheck: false,
          autoComplete: 'off',
          placeholder: t('placeholder'),
          'aria-label': t('placeholder'),
          onChange: (event) => {
            setValue(event.target.value);
          },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            finder.step(event.shiftKey ? -1 : 1);
          },
        }),
        h(
          'span',
          {
            style: {
              minWidth: '46px',
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
            },
            'aria-live': 'polite',
          },
          status === 'empty' ? t('empty') : status
        ),
        h(
          'button',
          {
            type: 'button',
            style: stepButton,
            title: t('prev'),
            'aria-label': t('prev'),
            disabled: disabled,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => finder.step(-1),
          },
          icon(ICON_UP)
        ),
        h(
          'button',
          {
            type: 'button',
            style: stepButton,
            title: t('next'),
            'aria-label': t('next'),
            disabled: disabled,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => finder.step(1),
          },
          icon(ICON_DOWN)
        ),
        h(
          'button',
          {
            type: 'button',
            style: button,
            title: t('close'),
            'aria-label': t('close'),
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => props.onClose(),
          },
          icon(ICON_CLOSE)
        )
      );
    }

    // ------------------------------------------------------------------ plugin

    const inject = ['slots', 'locale', 'shortcuts'];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: zh,
            en: en,
          }),
        'ui-find-bar: copy'
      );
      const t = ctx.locale.bind(NS);
      const finder = createFinder();
      const platform = platformOf();
      const listeners = new Set();
      let isOpen = false;

      function publish(next) {
        if (isOpen === next) return;
        isOpen = next;
        for (const listener of listeners) listener(isOpen);
      }

      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'find-bar', order: 50 },
              () =>
                h(FindBar, {
                  finder: finder,
                  t: t,
                  isOpen: () => isOpen,
                  onClose: () => publish(false),
                  subscribe: (listener) => {
                    listeners.add(listener);
                    return () => {
                      listeners.delete(listener);
                    };
                  },
                })
            )
          ),
        'ui-find-bar: overlay surface'
      );

      ctx.effect(
        () =>
          ctx.shortcuts.register({
            id: 'find.inPage',
            label: () => t('open'),
            aliases: ['find', 'search in page', '查找', '页面内查找'],
            defaults: {
              'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
              'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
              'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
            },
            regions: ['page'],
            modals: [],
            resolve: () => ({
              status: 'handled',
              run: () => publish(!isOpen),
            }),
          }),
        'ui-find-bar: Ctrl+F'
      );

      ctx.effect(() => () => finder.dispose(), 'ui-find-bar: highlights');

      if (typeof window !== 'undefined') {
        window.__dshFindBar = {
          open: () => publish(true),
          close: () => publish(false),
          search: (query) => finder.search(query),
          next: () => finder.step(1),
          prev: () => finder.step(-1),
          finder: finder,
          platform: platform,
        };
      }
    }

    return {
      inject: inject,
      apply: apply,
    };
  },
});
