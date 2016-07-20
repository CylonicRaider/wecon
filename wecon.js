/* wecon -- Web Console emulator
 * https://github.com/CylonicRaider/wecon */

/* Hide implementation details in closure */
this.Terminal = function() {
  /* Convenience function to create a DOM node */
  function makeNode(tagName, className) {
    var ret = document.createElement(tagName);
    if (className) ret.className = className;
    return ret;
  }

  /* Passive UTF-8 decoder */
  function UTF8Dec() {
    this._buffered = [];
    this.replacement = "\ufffd";
  }

  UTF8Dec.prototype = {
    /* String.fromCodePoint shim */
    _fromCodePoint: (String.fromCodePoint) ?
        String.fromCodePoint.bind(String) : function(cp) {
      if (cp <=  0xFFFF) return String.fromCharCode(cp);
      if (cp > 0x10FFFF) throw RangeError("Bad code point: " + cp);
      cp -= 0x10000;
      return String.fromCharCode(cp >>> 10 | 0xD800, cp & 0x3FF | 0xDC00);
    },

    /* Return by how many bytes the end of the buffer is incomplete, or zero
     * if not */
    _checkIncomplete: function(buffer) {
      var i, e = buffer.length - 9;
      if (e < 0) e = 0;
      for (i = buffer.length - 1; i >= e; i--) {
        /* Stop at ASCII bytes */
        if (! (buffer[i] & 0x80)) break;
        /* Skip continuation bytes */
        if ((buffer[i] & 0xC0) == 0x80) continue;
        /* Determine sequence length */
        var sl = 2;
        while (sl <= 7 && buffer[i] >> (7 - sl) & 1) sl++;
        /* Done */
        var ret = sl - (buffer.length - i);
        return (ret < 0) ? 0 : ret;
      }
      return 0;
    },

    /* Actually decode */
    _decode: function(codes) {
      var ret = "", i = 0, l = codes.length;
      while (i < l) {
        if ((codes[i] & 0x80) == 0x00) {
          /* ASCII byte */
          ret += String.fromCharCode(codes[i++]);
        } else if ((codes[i] & 0xC0) == 0x80) {
          /* Orphan continuation byte */
          ret += this.replacement;
          while ((codes[i] & 0xC0) == 0x80) i++;
        } else {
          /* Proper sequence */
          var cl = 1, v = codes[i++];
          /* Determine length */
          while (cl <= 6 && v >> (6 - cl) & 1) cl++;
          var sl = cl + 1, cp = v & (1 << (6 - cl)) - 1;
          /* Handle truncated sequences */
          if (l - i < cl) {
            ret += this.replacement;
            break;
          }
          /* Compose codepoint */
          for (; cl; cl--) {
            v = codes[i++];
            if (v & 0xC0 != 0xC0) break;
            cp = (cp << 6) | v & 0x3F;
          }
          /* Handle bad sequences */
          if (cl) {
            ret += this.replacement;
            continue;
          }
          /* Add to output */
          ret += this._fromCodePoint(cp);
        }
      }
      /* Done */
      return ret;
    },

    /* Decode the input or part of it, possibly buffering a codepoint */
    decode: function(input) {
      var ret = "", i;
      /* Take care of buffered codepoint(s) */
      if (this._buffered.length) {
        /* Scan for continuation bytes and buffer them */
        for (i = 0; i < input.length; i++) {
          if ((input[i] & 0xC0) != 0x80) break;
          this._buffered.push(input[i]);
        }
        /* Check if the buffer is (still) incomplete */
        if (! this._checkIncomplete(this._buffered)) {
          /* Flush buffer into return value */
          ret += this.flush();
        }
        /* Cut buffered bytes off input */
        input = input.slice(i);
      }
      /* Scan for incomplete sequences and buffer them */
      i = this._checkIncomplete(input);
      if (i) {
        var e = input.length - i;
        var tail = Array.prototype.slice.apply(input.slice(e, input.length));
        Array.prototype.splice.apply(this._buffered,
          [this._buffered.length, 0].concat(tail));
        input = input.slice(0, e);
      }
      /* Decode rest of input */
      ret += this._decode(input);
      return ret;
    },

    /* Forcefully drain the decoder and return any characters left */
    flush: function() {
      if (! this._buffered.length) return "";
      /* buffered should only contain invalid sequences, but one can never
       * know */
      var b = this._buffered;
      this._buffered = [];
      return this._decode(b);
    }
  };

  /* Actual terminal emulator. options specifies parameters of the terminal:
   * width     : The terminal should have the given (fixed) width; if not set,
   *             it will adapt to the container.
   * height    : Fixed height.
   * bell      : An <audio> element (or anything having a play() method) that
   *             should be invoked for a BEL character.
   * visualBell: If true, bells will be indicated by shortly flashing the
   *             terminal output, independently from bell.
   * scrollback: Length of the scrollback buffer. When not set or less than
   *             the current height, all lines "above" the display area are
   *             immediately discarded; when set to positive infinity,
   *             arbitrarily many lines are stored.
   * Additional attributes:
   * node    : The DOM node the terminal is residing in.
   * size    : The actual size of the terminal as a [width, height] array (in
   *           character cells), or null if never shown yet.
   * curPos  : The current cursor position as an (x, y) array. Both
   *           coordinates must be not less than zero; the y coordinate must
   *           be less than the height and the x coordinate must be not
   *           greater (!) than the width. The initial value is [0, 0].
   *           NOTE (explicitly) that the x coordinate may be equal to the
   *                width.
   *           Changing the attribute will not update the DOM; invoke the
   *           placeCursor() method for that.
   * curFg   : The current foreground color index, or null if the default is
   *           to be used.
   * curBg   : The current background color index, or null if the default is
   *           to be used.
   * curAttrs: The current display attributes as a bitmask of the constants
   *           Terminal.ATTR.*.
   */
  function Terminal(options) {
    if (! options) options = {};
    this.width = options.width;
    this.height = options.height;
    this.bell = options.bell;
    this.visualBell = options.visualBell;
    this.scrollback = options.scrollback;
    this.node = null;
    this.size = null;
    this.savedAttributes = null;
    this._currentScreen = 0;
    this._decoder = new UTF8Dec();
    this._resize = this.resize.bind(this);
    this._pendingBells = [];
    this.reset(false);
  }

  /* Text attribute bits */
  Terminal.ATTR = {
    BOLD        :   1, /* Bold */
    DIM         :   2, /* Half-bright */
    ITALIC      :   4, /* Italic */
    UNDERLINE   :   8, /* Underlined */
    BLINK       :  16, /* Blinking */
    FASTBLINK   :  32, /* Fast blinking */
    REVERSE     :  64, /* Reverse video */
    HIDDEN      : 128, /* Text hidden */
    STRIKE      : 256, /* Strikethrough */
    DBLUNDERLINE: 512, /* Double underline */
    _MAX        : 512  /* Greatest attribute defined */
  };

  /* Text attribute codenames */
  Terminal.ATTRNAME = {
      1: "bold",
      2: "dim",
      4: "italic",
      8: "underline",
     16: "blink",
     32: "fastblink",
     64: "reverse",
    128: "hidden",
    256: "strike",
    512: "dblunderline"
  };

  Terminal.prototype = {
    /* Install the terminal into the given node
     * If it is already mounted into another node, it is entirely relocated
     * to the new position.
     */
    mount: function(node) {
      if (this.node) {
        node.innerHTML = "";
        while (this.node.lastElementChild) {
          node.appendChild(this.node.lastElementChild);
        }
        this.unmount();
      }
      this.node = node;
      node.classList.add("wecon");
      window.addEventListener("resize", this._resize);
      this._oldSize = null;
      this.selectScreen(this._currentScreen);
    },

    /* Remove the terminal from its current node (if any) and make it
     * "virtual"
     * The node's contents are cleaned up, unless the "raw" argument
     * is true.
     */
    unmount: function(raw) {
      if (this.node && ! raw) {
        this.node.classList.remove("wecon");
        this.node.innerHTML = "";
        window.removeEventListener("resize", this._resize);
      }
      this._oldSize = null;
      this.node = null;
    },

    /* Throw an error if the terminal is not mounted */
    checkMounted: function() {
      if (! this.node) throw new Error("Terminal not mounted");
    },

    /* Update the sizes of the content area and the container */
    resize: function(force) {
      this.checkMounted();
      /* Ignore if size not changed */
      if (this._oldSize && ! force) {
        if (this.node.offsetWidth == this._oldSize[0] &&
            this.node.offsetHeight == this._oldSize[1])
          return;
      }
      /* Prepare scroll-to-bottom */
      var scroll = this._prepareScroll();
      /* Extract content area node */
      var content = this._contentNode();
      var measureStyle = getComputedStyle(content, "::before");
      /* Scrollback */
      if (this.scrollback != null) {
        content.classList.add("scroll");
      } else {
        content.classList.remove("scroll");
      }
      /* Reset width and height for calculation */
      content.style.width = "";
      content.style.height = "";
      /* Scrollbar size */
      var sbSize = content.offsetWidth - content.clientWidth;
      var ch = parseFloat(measureStyle.width);
      var em = parseFloat(measureStyle.height);
      /* Calculate width and height */
      var curWidth, curHeight;
      if (this.width) {
        /* Fixed width */
        content.classList.add('fixed-width');
        content.style.width = (this.width * ch + sbSize) + "px";
        content.style.paddingRight = "";
        this.node.style.minWidth = content.offsetWidth + "px";
        curWidth = this.width;
      } else {
        /* Dynamic width */
        curWidth = (this.node.offsetWidth - sbSize) / ch | 0;
        var ew = (curWidth * ch + sbSize);
        content.classList.remove('fixed-width');
        content.style.width = this.node.offsetWidth + "px";
        content.style.paddingRight = (this.node.offsetWidth - ew) + "px";
        this.node.style.minWidth = "";
      }
      if (this.height) {
        /* Fixed height */
        content.classList.add('fixed-height');
        var eh = this.height * em;
        content.style.height = eh + "px";
        this.node.style.minHeight = eh + "px";
        curHeight = this.height;
      } else {
        /* Dynamic height */
        curHeight = this.node.offsetHeight / em | 0;
        content.classList.remove('fixed-height');
        content.style.height = (curHeight * em) + "px";
        this.node.style.minHeight = "";
      }
      /* Store pixel size for later checking */
      this._oldSize = [this.node.offsetWidth, this.node.offsetHeight];
      /* Store window size */
      if (this.size) {
        this.size[0] = curWidth;
        this.size[1] = curHeight;
      } else {
        this.size = [curWidth, curHeight];
      }
      /* Update bottom padding */
      this._updatePadding();
      /* Scroll to bottom */
      scroll();
    },

    /* Reset the entire terminal or the current screen */
    reset: function(full) {
      if (full && this.node) {
        this.node.innerHTML = "";
        this.selectScreen(0);
      } else {
        this.curPos = [0, 0];
        this.curFg = null;
        this.curBg = null;
        this.curAttrs = 0;
        this._offscreenLines = 0;
        if (this.node) {
          var cn = this._contentNode();
          if (cn) {
            cn.innerHTML = "";
            this._prepareAttrs()(cn);
          }
        }
      }
    },

    /* Update for changed line amount */
    _updatePadding: function() {
      this.checkMounted();
      /* May have to shift cursor */
      if (this.curPos[0] > this.size[0])
        this.curPos[0] = this.size[0];
      var shift = this.curPos[1] - this.size[1] + 1;
      if (shift < 0) shift = 0;
      /* Shift up */
      if (shift) {
        this.curPos[1] -= shift;
        this._offscreenLines += shift;
      }
      /* Determine necessary line amount */
      var content = this._contentNode();
      var lines = content.children;
      var rl = lines.length;
      if (this._offscreenLines)
        rl = this._offscreenLines + this.size[1];
      /* Remove overflowing lines */
      while (lines.length > rl) {
        /* Garbage-collect cells */
        this._clearLine(content.lastElementChild, false);
        /* Actually dispose of line */
        content.removeChild(content.lastElementChild);
      }
      /* Add new lines as padding */
      while (lines.length < rl) {
        content.appendChild(makeNode("div"));
      }
      /* Update cursor node */
      this._placeCursor();
    },

    /* Return a closure that scrolls the terminal window as appropriate
     * after modifications */
    _prepareScroll: function() {
      this.checkMounted();
      var content = this._contentNode();
      var atBottom = (content.scrollTop + content.clientHeight >=
                      content.scrollHeight);
      return function() {
        if (atBottom) {
          content.scrollTop = content.scrollHeight - content.clientHeight;
        }
      };
    },

    /* Select an alternate screen
     * The ID can be a number, or a string (which must only consist of
     * alphanumerics, dashes, and underscores).
     * If no such screen is present, it is allocated.
     */
    selectScreen: function(id) {
      this.checkMounted();
      /* Validate ID */
      if (typeof id == "string" && ! /^[a-zA-Z0-9_-]*$/.test(id))
        throw new Error("Bad screen ID: " + id);
      /* Freeze data into old node */
      var node = this._contentNode();
      if (node) {
        node.setAttribute("data-cursor-x", this.curPos[0]);
        node.setAttribute("data-cursor-y", this.curPos[1]);
        node.setAttribute("data-cur-fg", this.curFg || "");
        node.setAttribute("data-cur-bg", this.curBg || "");
        node.setAttribute("data-cur-attrs", this.curAttrs);
        node.setAttribute("data-offscreen-lines", this._offscreenLines);
        node.classList.remove("visible");
      }
      /* Thaw data from new node, or allocate one */
      node = this.node.querySelector("pre[data-screen-id=\"" + id + "\"]");
      if (node) {
        /* Restore parameters */
        this.curPos = [+node.getAttribute("data-cursor-x"),
                       +node.getAttribute("data-cursor-y")];
        this.curFg = node.getAttribute("data-cur-fg") || null;
        this.curBg = node.getAttribute("data-cur-bg") || null;
        this.curAttrs = +node.getAttribute("data-cur-attrs");
        this._offscreenLines = +node.getAttribute("data-offscreen-lines");
        /* Remove old values */
        node.removeAttribute("data-cursor-x");
        node.removeAttribute("data-cursor-y");
        node.removeAttribute("data-cur-fg");
        node.removeAttribute("data-cur-bg");
        node.removeAttribute("data-cur-attrs");
        node.removeAttribute("data-offscreen-lines");
        node.classList.add("visible");
      } else {
        /* Allocate new node */
        node = makeNode("pre");
        node.setAttribute("data-screen-id", id);
        this.node.appendChild(node);
        node.classList.add("visible");
        /* Reset */
        this.reset(false);
      }
      /* Update current ID */
      this._currentScreen = id;
      /* Update node size */
      this.resize(true);
    },

    /* Return the ID of the currently selected alternate screen
     * The default one is zero.
     */
    currentScreen: function() {
      return this._currentScreen;
    },

    /* Return the DOM node containing the current screen's content */
    _contentNode: function() {
      return this.node.querySelector("pre.visible");
    },

    /* Return an array with the indicated portion of the given line's
     * cells */
    _cellRange: function(line, from, to) {
      var ch = line.children, cl = line.children.length;
      if (from == null && to == null) {
        return Array.prototype.slice.call(ch);
      } else if (from == null) {
        return Array.prototype.slice.call(ch, 0, Math.min(to, cl));
      } else if (to == null) {
        return Array.prototype.slice.call(ch, Math.max(0, from), cl);
      } else {
        return Array.prototype.slice.call(ch, Math.max(0, from),
                                          Math.min(to, cl));
      }
    },

    /* Garbage-collect all the cells from line
     * If remove is true, they are also unlinked from it, otherwise,
     * it is assumed that the line will be disposed of itself. */
    _clearLine: function(line, remove) {
      var range = this._cellRange(line);
      if (remove) {
        range.forEach(line.removeChild.bind(line));
      }
    },

    /* Add line nodes as necessary to be able to display the given
     * coordinate, or the y part of the cursor position
     * Returns the line in question.
     */
    growLines: function(y) {
      this.checkMounted();
      /* Insert default value */
      if (y == null) y = this.curPos[1];
      /* Obtain contents and lines */
      var content = this._contentNode();
      var lines = content.children;
      var attrs = this._prepareAttrs(content);
      /* Amend lines */
      var fullLength = this._offscreenLines + y + 1;
      while (lines.length < fullLength) {
        var node = makeNode("div");
        attrs(node);
        content.appendChild(node);
      }
      /* Update _offscreenLines */
      if (y >= this.size[1]) {
        this._offscreenLines += y - this.size[1] + 1;
        y = this.size[1] - 1;
      }
      /* Remove lines to maintain scroll buffer size */
      var capLength = this.scrollback || 0;
      if (capLength < this.size[1]) capLength = this.size[1];
      while (lines.length > capLength) {
        /* Garbage-collect cells */
        this._clearLine(lines[0], false);
        /* Actually dispose of line */
        content.removeChild(lines[0]);
        /* Decrement offscreen line count */
        this._offscreenLines--;
      }
      return lines[this._offscreenLines + y];
    },

    /* Return the line as indicated by the given coordinate, or undefined the
     * line is absent */
    getLine: function(y) {
      this.checkMounted();
      var content = this._contentNode();
      return content.children[this._offscreenLines + y];
    },

    /* Return the cell immediately following the given one
     * If make is true, a new cell is created on demand.
     */
    _nextCell: function(cell, make) {
      var ret = cell.nextElementChild;
      if (! ret && make) {
        ret = makeNode("span", "cell");
        cell.parentNode.appendChild(ret);
      }
      return ret;
    },

    /* Ensure there are enough cells in the given line to reach the
     * given x coordinate
     * If pad is true, the cells left of the cell in question are filled
     * with spaces if empty.
     * Returns the (possibly) newly-made cell at the given position.
     */
    growCells: function(line, x, pad) {
      this.checkMounted();
      var attrs = this._prepareAttrs(line);
      var children = line.children, cell;
      for (var i = 0; i <= x; i++) {
        cell = children[i];
        if (! cell) {
          cell = makeNode("span", "cell");
          line.appendChild(cell);
          attrs(cell);
        }
        if (pad && ! cell.textContent) cell.textContent = " ";
      }
      return cell;
    },

    /* Move the cursor to the given coordinates or to the stored cursor
     * position */
    _placeCursor: function(x, y) {
      this.checkMounted();
      /* Resolve coordinates */
      if (x == null) x = this.curPos[0];
      if (y == null) y = this.curPos[1];
      /* Check whether overflowing */
      var overflow = (x >= this.width);
      if (overflow) x = this.width;
      /* Extract current cell */
      var line = this.growLines(y);
      var cell = this.growCells(line, x, false);
      /* Remove old cursor */
      var cursor = line.parentNode.getElementsByClassName("cursor")[0];
      if (cursor) {
        cursor.classList.remove("cursor");
        cursor.classList.remove("overflow");
      }
      /* Install new cursor */
      cell.classList.add("cursor");
      if (overflow) cell.classList.add("overflow");
      /* Write back cursor coordinates */
      this.curPos[0] = x;
      this.curPos[1] = y;
    },

    /* Place the cursor at the given coordinates
     * The position is clamped to fit into the window. */
    placeCursor: function(x, y) {
      var p = this._resolvePosition([x, y]);
      this._placeCursor(p[0], p[1]);
    },

    /* Move the cursor relatively to its current position */
    moveCursor: function(x, y) {
      this.placeCursor(this.curPos[0] + (x || 0),
                       this.curPos[1] + (y || 0));
    },

    /* Resolve the given position WRT the current cursor position
     * If pos or any part of it is missing, the cursor position (or the
     * corresponding part of it) is reported.
     * The position is ensured to be within the terminal's bounds.
     * The .fg, .bg, and .attrs are replaced by their counterparts
     * from this if not present (=== undefined).
     */
    _resolvePosition: function(pos) {
      if (! pos) pos = [this.curPos[0], this.curPos[1]];
      if (pos[0] == null) pos[0] = this.curPos[0];
      if (pos[1] == null) pos[1] = this.curPos[1];
      if (pos[0] > this.size[0]) pos[0] = this.size[0];
      if (pos[1] >= this.size[1]) pos[1] = this.size[1] - 1;
      if (pos[0] < 0) pos[0] = 0;
      if (pos[1] < 0) pos[1] = 0;
      if (pos.fg === undefined) pos.fg = this.curFg;
      if (pos.bg === undefined) pos.bg = this.curBg;
      if (pos.attrs === undefined) pos.attrs = this.curAttrs;
      return pos;
    },

    /* Resolve the given Y coordinate WRT the current cursor position
     * The .fg, .bg, .attrs attributes are filled in if necessary.
     */
    _resolveY: function(y) {
      /* Turn into an object */
      if (Array.isArray(y)) y = y[1];
      if (y == null) {
        y = new Number(this.curPos[1]);
      } else if (typeof y == "number") {
        y = new Number(y);
      } else if (Array.isArray(y)) {
        y = new Number(y[1]);
      }
      /* Insert attributes */
      if (y.fg === undefined) y.fg = this.curFg;
      if (y.bg === undefined) y.bg = this.curBg;
      if (y.attrs === undefined) y.attrs = this.curAttrs;
      /* Done */
      return y;
    },

    /* Return a closure which assigns the attributes as configured by base
     * to any cell it's called on
     * If base is null, the terminal's current attributes are used.
     * If base is a DOM node, its data-attrs attribute is applied.
     */
    _prepareAttrs: function(base) {
      var attrs = "";
      if (base == null)
        base = {attrs: this.curAttrs, fg: this.curFg, bg: this.curBg};
      if (typeof base == "object" && base.nodeType !== undefined) {
        attrs = base.getAttribute("data-attrs");
      } else {
        /* Scan attributes */
        for (var i = 1; i <= Terminal.ATTR._MAX; i <<= 1) {
          if (base.attrs & i) attrs += " " + Terminal.ATTRNAME[i];
        }
        /* Special-case reverse video */
        if (base.attrs & Terminal.ATTR.REVERSE)
          base = {fg: base.bg, bg: base.fg, attrs: base.attrs};
        /* Foreground and background */
        if (base.fg != null) {
          attrs += " fg-" + base.fg;
        } else {
          attrs += " fg-default";
        }
        if (base.bg != null) {
          attrs += " bg-" + base.bg;
        } else {
          attrs += " bg-default";
        }
        /* Strip leading space */
        attrs = attrs.replace(/^ /, "");
      }
      /* Result */
      if (attrs) {
        return function(node) {
          node.setAttribute("data-attrs", attrs);
        };
      } else {
        return function(node) {
          node.removeAttribute("data-attrs");
        };
      }
    },

    /* Draw some text onto the output area
     * Writing starts at pos (falling back to the current cursor coordinates
     * when pos is null, or falling back at the x and y coordinate of the
     * cursor is the respective elements of pos are null), wraps lines as
     * appropriate, and stores the new cursor position unless noMove is true.
     * Control characters (including CR and LF) are rendered as normal text.
     */
    writeTextRaw: function(text, pos, noMove) {
      this.checkMounted();
      /* Resolve initial position */
      pos = this._resolvePosition(pos);
      var attrs = this._prepareAttrs(pos);
      /* Save decremented width; do not perform costy DOM manipulation if
       * no text given */
      var tlm1 = text.length - 1;
      if (tlm1 >= 0) {
        /* Might have to scroll to the bottom */
        var scroll = this._prepareScroll();
        /* Get line array */
        var content = this._contentNode();
        var lines  = content.children;
        /* Current line, current cell */
        var cl = null, cc = null;
        /* For each character */
        for (var i = 0; i <= tlm1; i++) {
          var ch = text[i];
          /* Decode surrogate pairs */
          if (/[\uD800-\uDBFF]/.test(ch) && i < tlm1 &&
              /[\uDC00-\uDFFF]/.test(text[i + 1]))
            ch += text[++i];
          /* Perform line wrapping; advance cell */
          if (pos[0] == this.size[0]) {
            pos[0] = 0;
            pos[1]++;
            cl = this.growLines(pos[1]);
            if (pos[1] == this.size[1]) pos[1]--;
            /* Select first cell */
            cc = this.growCells(cl, 0);
          } else if (! cl) {
            /* First loop run -- select correct line and cell */
            cl = this.growLines(pos[1]);
            cc = this.growCells(cl, pos[0], true);
          }
          /* Embed character into cell */
          attrs(cc);
          cc.textContent = ch;
          /* Advance character */
          pos[0]++;
          if (pos[0] != this.size[0]) cc = this._nextCell(cc, true);
        }
        /* Scroll to bottom if necessary */
        scroll();
      }
      /* Update cursor position if told to */
      if (noMove) {
        this._placeCursor();
      } else {
        this._placeCursor(pos[0], pos[1]);
      }
    },

    /* Insert text at the given position (or the cursor position), shifting
     * the remainder of the line to the right
     * Since this is inherently a line-based operation, no wrapping is
     * performed. Unless noDiscard is true, the characters pushed out of the
     * visible area.
     * If text is a number, the amount of spaces as indicated by it is
     * inserted.
     */
    insertTextRaw: function(text, pos, noDiscard) {
      this.checkMounted();
      /* Resolve position */
      pos = this._resolvePosition(pos);
      var attrs = this._prepareAttrs(pos);
      /* Acquire various variables */
      var line = this.growLines(pos[1]);
      var cell = this.growCells(line, pos[0], true);
      var isNumber = (typeof text == "number");
      var tlm1 = (isNumber) ? text - 1 : text.length - 1;
      if (noDiscard) n = Math.min(n, this.size[0]);
      for (var i = 0; i <= tlm1; i++) {
        var ch = (isNumber) ? " " : text[i];
        /* Decode surrogate pairs */
        if (/[\uD800-\uDBFF]/.test(ch) && i < tlm1 &&
            /[\uDC00-\uDFFF]/.test(text[i + 1]))
          ch += text[++i];
        /* Insert character */
        var nc = makeNode("span", "cell");
        attrs(nc);
        nc.textContent = ch;
        line.insertBefore(nc, cell);
      }
      /* Truncate line if necessary */
      if (! noDiscard) {
        this.eraseLine(false, true, [this.size[0], pos[1]]);
      }
      /* Ensure the cursor has not moved away */
      this._placeCursor();
    },

    /* Remove some amount of characters one a line and insert some blank
     * ones
     * After removing remove characters at the current position (without
     * moving the cursor), inserts insert blank characters at the same
     * position (still without moving the cursor).
     * pos (and individual coordinates of it) default to the current
     * cursor position. If noDiscard is true, excess characters are not
     * dropped from the line after insertion.
     * NOTE that pos is the first argument to maintain similarity to
     *      Array.prototype.splice.
     */
    spliceCharacters: function(pos, remove, insert, noDiscard) {
      /* Obtain line */
      pos = this._resolvePosition(pos);
      var line = this.getLine(pos[1]);
      if (! line) return;
      /* Remove cells */
      this._cellRange(line, pos[0],
                      pos[0] + remove).forEach(line.removeChild.bind(line));
      /* Add cells */
      this.insertTextRaw(insert, pos, noDiscard);
    },

    /* Remove and insert some amount of lines after the given position */
    spliceLines: function(y, remove, insert) {
      this.checkMounted();
      /* Resolve coordinate */
      if (y == null) y = this.curPos[1];
      var content = this._contentNode();
      var lines = content.children;
      /* Remove lines */
      for (var i = 0; i < remove; i++) {
        var line = lines[this._offscreenLines + y];
        if (! line) break;
        this._clearLine(line, false);
        content.removeChild(line);
      }
      /* Insert lines */
      var ln = this.getLine(y);
      if (ln) {
        if (insert > this.size[1]) insert = this.size[1];
        for (var i = 0; i < insert; i++) {
          content.insertBefore(makeNode("div"), ln);
        }
      }
      /* Retain scrolling position */
      this._updatePadding();
    },

    /* Erase part of the line as indicated by pos or the cursor position */
    eraseLine: function(before, after, pos) {
      /* Resolve position */
      pos = this._resolvePosition(pos);
      var attrs = this._prepareAttrs(pos);
      /* Determine line and bounds */
      var line = this.getLine(pos[1]);
      if (! line) return;
      var from = pos[0], to = pos[0] + 1;
      if (before) from = null;
      if (after) to = null;
      /* Actually erase */
      var range = this._cellRange(line, from, to);
      if (after) {
        range.forEach(line.removeChild.bind(line));
        /* Assign attributes */
        attrs(line);
      } else {
        range.forEach(function(el) {
          el.textContent = " ";
          attrs(el);
        });
      }
      /* Ensure we did not remove the cursor */
      this._placeCursor();
    },

    /* Erase part of the display up to or after the cursor, and possibly
     * discard scrollback */
    eraseDisplay: function(before, after, scrollback, pos) {
      this.checkMounted();
      /* Resolve position */
      var pos = this._resolvePosition(pos);
      var attrs = this._prepareAttrs(pos);
      /* Obtain reference to line array */
      var content = this._contentNode();
      var lines = content.children;
      /* Clear line */
      this.eraseLine(before, after, pos);
      /* Clear lines above or below */
      if (before) {
        for (var y = 0; y < pos[1]; y++) {
          var ln = lines[this._offscreenLines + y];
          this._clearLine(ln, true);
          attrs(ln);
        }
      }
      if (after) {
        var fl = this._offscreenLines + pos[1] + 1;
        while (lines.length > fl) {
          var ln = content.lastElementChild;
          this._clearLine(ln, false);
          content.removeChild(ln);
        }
        attrs(content);
      }
      /* Clear scrollback */
      if (scrollback) {
        var fl = lines.length - this._offscreenLines;
        while (lines.length > fl) {
          this._clearLine(lines[0], false);
          content.removeChild(lines[0]);
        }
        this._offscreenLines = 0;
      }
      /* Update bottom padding */
      this._updatePadding();
    },

    /* Perform a carriage return and/or a line feed, possibly reversed
     * Since there is little meaning to an arbitrary-position variant of
     * this, the cursor position is used and updated unconditionally.
     */
    newLine: function(cr, lf, reverse) {
      this.checkMounted();
      /* Carriage return. Rather simple. */
      if (cr) this.curPos[0] = 0;
      /* Line feed. More complex. */
      if (lf) {
        if (reverse) {
          /* Reverse line feed. Waaah! */
          if (this.curPos[1] > 0) {
            this.curPos[1]--;
          } else {
            /* Insert fresh line */
            this.spliceLines(null, 0, 1);
          }
        } else {
          /* "Forward" line feed. */
          this.curPos[1]++;
          /* Scrolling will happen implicitly when _updatePadding() is
           * called (if necessary). */
        }
      }
      /* Make book-keeping DOM changes */
      this._updatePadding();
    },

    /* Set the current display attributes to the given values
     * fg and bg are color indices or null, attrs is a bitmask of the
     * Terminal.ATTR.* constants.
     * If fg or bg are truly (===) undefined, the corresponding values
     * are unchanged, attrs can be weakly equal to undefined (i.e. null)
     * not to affect the current value.
     */
    setAttributes: function(fg, bg, attrs) {
      if (fg !== undefined) this.curFg = fg;
      if (bg !== undefined) this.curBg = bg;
      if (attrs != undefined) this.curAttrs = attrs;
    },

    /* Return a closure that saves the current cursor position and attributes
     * and restores them upon being called
     * If noPersist is true, the attribute storage is *not* recorded for
     * later restoration by restoreAttributes().
     * The return value has an attribute .pos which stores the cursor
     * position, can be modified to change the restored state, and passed to
     * the position-aware methods.
     */
    saveAttributes: function(noPersist) {
      /* Actual restoration function. A new closure of this one will be
       * returned each time. */
      function restore() {
        self.setAttributes(this.pos.fg, this.pos.bg, this.pos.attrs);
        self.placeCursor(this.pos[0], this.pos[1]);
      }
      /* Save reference to current this. */
      var self = this;
      /* Store data */
      restore.pos = [this.curPos[0], this.curPos[1]];
      restore.pos.fg = this.curFg;
      restore.pos.bg = this.curBg;
      restore.pos.attrs = this.curAttrs;
      /* Possibly persist closure */
      var ret = restore.bind(restore);
      if (! noPersist) this.savedAttributes = ret;
      /* Done */
      return ret;
    },

    /* Restore the attributes as saved before by saveAttributes() */
    restoreAttributes: function() {
      if (this.savedAttributes) this.savedAttributes();
    },

    /* Invoke the terminal's bell or try to attract user attention otherwise
     * If no acoustical bell is present, the visual bell is invoked.
     */
    beep: function() {
      /* Helper */
      var bellRunner = function(old) {
        if (old) old.classList.remove("bell");
        var node = this._pendingBells.shift();
        if (! node) return;
        node.classList.add("bell");
        setTimeout(function() {
          bellRunner(node);
        }, 100);
      }.bind(this);
      this.checkMounted();
      if (this.visualBell || ! this.bell) {
        var start = (! this._pendingBells.length);
        this._pendingBells.push(this._contentNode());
        if (start) bellRunner();
      } else {
        this.bell.play();
      }
    }
  };

  /* Return export */
  return Terminal;
}();
