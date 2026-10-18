/**
 * Harness for the find bar's search core. It loads the real client.js factory
 * with a minimal DOM shim and exercises the finder through the plugin entry
 * point that is exposed on window.
 */
const fs = require('fs');
const path = require('path');

const CLIENT = process.argv[2];
const source = fs.readFileSync(CLIENT, 'utf8');

// ------------------------------------------------------------------ DOM shim

const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

class TextNode {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = null;
  }
  get length() {
    return this.nodeValue.length;
  }
}

class ElementNode {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.parentElement = null;
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.scrollCalls = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    if (child instanceof ElementNode && child.parentElement) child.parentElement.removeChild(child);
    // In a real DOM an element's parentElement is null when its parent is a Document.
    child.parentElement = this.nodeType === 1 ? this : null;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentElement = this.nodeType === 1 ? this : null;
    child.parentNode = null;
    return child;
  }
  get firstChild() {
    return this.children.length === 0 ? null : this.children[0];
  }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  closest(selector) {
    const test = (element) => {
      if (selector === '[data-shell-overlay]') return element.hasAttribute('data-shell-overlay');
      if (selector === '[data-shell-leading]') return element.hasAttribute('data-shell-leading');
      return false;
    };
    let node = this;
    while (node) {
      if (node.nodeType === 1 && test(node)) return node;
      node = node.parentElement;
    }
    return null;
  }
  scrollIntoView() {
    this.scrollCalls += 1;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  collectTextNodes(out) {
    for (const child of this.children) {
      if (child instanceof TextNode) out.push(child);
      else child.collectTextNodes(out);
    }
    return out;
  }
  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node === doc.body || node === doc.documentElement;
  }
}

class DocumentNode extends ElementNode {
  constructor() {
    super('#document');
    this.nodeType = 9;
    this.documentElement = new ElementNode('html');
    this.head = new ElementNode('head');
    this.body = new ElementNode('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tag) {
    return new ElementNode(tag);
  }
  createDocumentFragment() {
    return new ElementNode('#fragment');
  }
  createRange() {
    const doc = this;
    return {
      startContainer: null,
      endContainer: null,
      startOffset: 0,
      endOffset: 0,
      setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
      },
      setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
      },
      getClientRects() {
        const text = this.startContainer.nodeValue.slice(this.startOffset, this.endOffset);
        return [{ left: 10 + this.startOffset, top: 20, width: Math.max(1, text.length * 7), height: 16 }];
      },
    };
  }
  createTreeWalker(root, whatToShow, filter) {
    const nodes = root.collectTextNodes([]);
    console.log('DEBUG walker root=' + root.tagName + ' candidates=' + JSON.stringify(nodes.map((n) => n.nodeValue)));
    let index = -1;
    return {
      currentNode: root,
      nextNode() {
        while (index + 1 < nodes.length) {
          index += 1;
          const node = nodes[index];
          const result = filter.acceptNode(node);
          console.log('DEBUG accept ' + JSON.stringify(node.nodeValue) + ' => ' + result);
          if (result === FILTER_ACCEPT) {
            this.currentNode = node;
            return node;
          }
        }
        return null;
      },
    };
  }
  getElementById(id) {
    const stack = [this.documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 1 && node.getAttribute('id') === id) return node;
      for (const child of node.children) if (child instanceof ElementNode) stack.push(child);
    }
    return null;
  }
}

const doc = new DocumentNode();
global.document = doc;
global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
global.NodeFilter = { SHOW_TEXT, FILTER_ACCEPT, FILTER_REJECT };
global.Element = ElementNode;
global.navigator = { platform: 'Win32', userAgentData: { platform: 'Windows' } };
global.window = {
  addEventListener() {},
  removeEventListener() {},
};
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.setInterval = () => 0;
global.clearInterval = () => {};
global.setTimeout = (fn) => {
  void fn;
  return 0;
};

// ------------------------------------------------------------- plugin loading

let captured = null;
window.__ModuleLoader__ = {
  load(descriptor) {
    captured = descriptor;
  },
};
new Function('window', 'document', 'Node', 'NodeFilter', 'Element', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', source)(
  global.window,
  doc,
  global.Node,
  global.NodeFilter,
  ElementNode,
  global.navigator,
  global.requestAnimationFrame,
  global.cancelAnimationFrame,
  global.setInterval,
  global.clearInterval,
  global.setTimeout
);

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exitCode = 1;
    return false;
  }
  console.log('ok: ' + message);
  return true;
}

if (!captured) {
  console.error('FAIL: client.js did not register a module');
  process.exit(1);
}
assert(captured.id === '@local/dsh-find-bar', 'module id is the package name');

const React = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
};

let registered = null;
const ctx = {
  effect(factory) {
    factory();
    return () => {};
  },
  locale: {
    register() {},
    bind() {
      return (key) => key;
    },
  },
  slots: {
    inject(name, factory) {
      void name;
      factory();
    },
    register(options, component) {
      registered = { options, component };
      return () => {};
    },
  },
  shortcuts: {
    register(command) {
      registered = registered || {};
      registered.command = command;
      return () => {};
    },
  },
};

const exportsObject = captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
});
exportsObject.apply(ctx);

assert(Array.isArray(exportsObject.inject), 'plugin declares its injected services');
assert(exportsObject.inject.indexOf('shortcuts') !== -1, 'plugin injects shortcuts');
assert(registered && registered.options.name === 'shell.overlay', 'registers the shell.overlay slot');
assert(registered.command && registered.command.id === 'find.inPage', 'registers the find.inPage command');
assert(
  registered.command.defaults['desktop:windows'].code === 'KeyF' &&
    registered.command.defaults['desktop:windows'].modifiers[0] === 'primary',
  'desktop default binding is Ctrl+F'
);

const api = global.window.__dshFindBar;
assert(api && typeof api.search === 'function', 'exposes a search entry point');

// --------------------------------------------------------------- search cases

function text(value) {
  return new TextNode(value);
}
function el(tag, ...children) {
  const node = new ElementNode(tag);
  for (const child of children) node.appendChild(child);
  return node;
}

const chat = el('div');
chat.appendChild(text('alpha beta GAMMA '));
chat.appendChild(text('beta delta'));
const overlay = el('div');
overlay.setAttribute('data-shell-overlay', '');
overlay.appendChild(text('beta in overlay'));
const hidden = el('div');
hidden.setAttribute('hidden', '');
hidden.appendChild(text('beta hidden'));
const ignored = el('div');
ignored.setAttribute('data-find-bar-ignore', '');
ignored.appendChild(text('beta highlighted markup'));
const script = el('script', text('beta in script'));
const nested = el('span', text('nested beta'));
chat.appendChild(nested);
doc.body.appendChild(chat);
doc.body.appendChild(overlay);
doc.body.appendChild(hidden);
doc.body.appendChild(ignored);
doc.body.appendChild(script);

const finder = api.finder;
const unregister = finder.register(chat);
finder.open();

console.log('DEBUG body children:', doc.body.children.map((c) => c.tagName + (c.getAttribute('data-find-bar-ignore') !== null ? '[ignore]' : '')).join(','));
console.log('DEBUG chat isConnected:', chat.isConnected, 'contains t1:', chat.contains(chat.children[0]));

// The bar re-renders from finder notifications; without them the counter and the
// arrow buttons describe the previous query.
let notifications = 0;
const unsubscribe = finder.subscribe(() => {
  notifications += 1;
});

finder.search('beta');
console.log('DEBUG after search status:', JSON.stringify(finder.status()));
assert(notifications >= 1, 'search notifies subscribers');
const beforeStep = notifications;
finder.step(1);
assert(notifications > beforeStep, 'stepping notifies subscribers');
finder.step(-1);
unsubscribe();

const status = finder.status();
assert(status === '1/3', 'finds only visible chat matches (got ' + status + ')');

finder.step(1);
assert(finder.status() === '2/3', 'Enter advances to the next match');
finder.step(1);
assert(finder.status() === '3/3', 'Enter advances to the last match');
finder.step(1);
assert(finder.status() === '1/3', 'Enter wraps to the first match');
finder.step(-1);
assert(finder.status() === '3/3', 'Shift+Enter wraps backwards');

finder.search('GAMMA');
assert(finder.status() === '1/1', 'search is case-insensitive');
finder.search('nothing-here');
assert(finder.status() === 'empty', 'reports an empty result set');
finder.search('');
assert(finder.status() === '', 'clears the result set for an empty query');

// Regression: a text node holding newlines / repeated spaces used to shift the
// range, because the haystack was whitespace-normalised while the offsets were
// applied to the raw string. Code blocks are exactly this shape.
const block = el('pre', text('line one\n    line two\npackage.json  # 包清单 here'));
chat.appendChild(block);
finder.search('清单');
const blockMatches = finder.debugMatches();
assert(blockMatches.length === 1, 'finds a match inside a multi-line text node');
const slice = blockMatches[0].node.nodeValue.slice(blockMatches[0].range.startOffset, blockMatches[0].range.endOffset);
assert(slice === '清单', 'highlight range slices exactly the query (got ' + JSON.stringify(slice) + ')');
finder.search('two');
const twoMatches = finder.debugMatches();
const twoSlice = twoMatches.length === 1 ? twoMatches[0].node.nodeValue.slice(twoMatches[0].range.startOffset, twoMatches[0].range.endOffset) : '<none>';
assert(twoSlice === 'two', 'match after repeated spaces keeps its offset (got ' + JSON.stringify(twoSlice) + ')');

finder.search('beta');
const boxes = doc.body.children.filter((child) => child.getAttribute('data-find-bar-highlights') !== null);
console.log('DEBUG body children after search:', doc.body.children.map((c) => c.tagName + ' attrs=' + JSON.stringify([...c.attributes.keys()])).join(' | '));
assert(boxes.length === 1, 'creates exactly one highlight layer');
assert(unregister !== undefined, 'register returns a disposer');
unregister();
finder.close();
const leftovers = doc.body.children.filter((child) => child.getAttribute('data-find-bar-highlights') !== null);
assert(leftovers.length === 0, 'close removes the highlight layer');

console.log(process.exitCode === 1 ? 'HARNESS FAILED' : 'HARNESS PASSED');
