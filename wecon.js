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

  /* DOM node accumulator
   * New nodes are created with the given tag and class. The node cache will
   * not grow larger than maxLength nodes.
   */
  function NodeCache(tagName, className, maxLength) {
    this.tagName = tagName;
    this.className = className;
    this.maxLength = maxLength;
    this._nodes = [];
  }

  NodeCache.prototype = {
    /* Obtain a node from the cache or create a new one */
    get: function() {
      if (this._nodes.length) return this._nodes.pop();
      return makeNode(this.tagName, this.className);
    },

    /* Add a node to the cache or dispose of it */
    add: function(node) {
      if (this._nodes.length >= this.maxLength) return;
      node.className = this.className;
      node.innerHTML = "";
      this._nodes.push(node);
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
   * node  : The DOM node the terminal is residing in.
   * size  : The actual size of the terminal as a [width, height] array (in
   *         character cells), or null if never shown yet.
   * curPos: The current cursor position as an (x, y) array. Both coordinates
   *         must be not less than zero; the y coordinate must be less than
   *         the height and the x coordinate must be not greater (!) than the
   *         width. The initial value is [0, 0].
   *         NOTE (explicitly) that the x coordinate may be equal to the
   *              width.
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
    this.curPos = [0, 0];
    this._offscreenLines = 0;
    this._decoder = new UTF8Dec();
    this._cells = new NodeCache("span", "cell", 1000);
    this._resize = this.resize.bind(this);
  }

  Terminal.prototype = {
    /* Text attribute bits */
    ATTR_BOLD     :   1, /* Bold */
    ATTR_DIM      :   2, /* Half-bright */
    ATTR_ITALIC   :   4, /* Italic */
    ATTR_UNDERLINE:   8, /* Underlined */
    ATTR_BLINK    :  16, /* Blinking */
    /* 6 is not assigned */
    ATTR_REVERSE  :  64, /* Reverse video */
    ATTR_HIDDEN   : 128, /* Text hidden */
    ATTR_STRIKE   : 256, /* Strikethrough */
    /* Double underline is NYI */

    /* Install the terminal into the given node
     * If it is already mounted into another node, it is (entirely) removed
     * from there.
     */
    mount: function(node) {
      if (this.node) {
        node.innerHTML = "";
        while (this.node.lastElementChild) {
          node.appendChild(this.node.lastElementChild);
        }
        this.unmount();
      } else {
        node.innerHTML = "<pre></pre>";
      }
      this.node = node;
      node.classList.add("wecon");
      if (this.scrollback != null)
        node.firstElementChild.classList.add("scroll");
      window.addEventListener("resize", this._resize);
      this._oldSize = null;
      this.resize();
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

    /* Update the sizes of the content area and the container */
    resize: function() {
      /* Ignore for "virtual" terminals */
      if (! this.node) return;
      /* Ignore if size not changed */
      if (this._oldSize) {
        if (this.node.offsetWidth == this._oldSize[0] &&
            this.node.offsetHeight == this._oldSize[1])
          return;
      }
      /* Extract content area node */
      var content = this.node.getElementsByTagName("pre")[0];
      var measureStyle = getComputedStyle(content, "::before");
      /* Reset width and height for calculation */
      content.style.width = "";
      content.style.height = "";
      /* Calculate width and height */
      var curWidth, curHeight;
      if (this.width) {
        /* Fixed width */
        content.classList.add('fixed-width');
        content.style.width = this.width + "ch";
        content.style.paddingRight = "";
        this.node.style.minWidth = content.offsetWidth + "px";
        curWidth = this.width;
      } else {
        /* Dynamic width */
        var sbSize = content.offsetWidth - content.clientWidth;
        var ch = parseFloat(measureStyle.width);
        curWidth = (this.node.offsetWidth - sbSize) / ch | 0;
        var ew = (curWidth * ch + sbSize);
        content.classList.remove('fixed-width');
        content.style.width = ew + "px";
        content.style.paddingRight = (this.node.offsetWidth - ew) + "px";
        this.node.style.minWidth = "";
      }
      if (this.height) {
        /* Fixed height */
        content.classList.add('fixed-height');
        content.style.height = this.height + "em";
        this.node.style.minHeight = content.offsetHeight + "px";
        curHeight = this.height;
      } else {
        /* Dynamic height */
        var em = parseFloat(measureStyle.height);
        curHeight = this.node.offsetHeight / em | 0;
        content.classList.remove('fixed-height');
        content.style.height = curHeight + "em";
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
      /* Update cursor */
      this._placeCursor();
    },

    /* Add line nodes as necessary to be able to display the given
     * coordinate, or the y part of the cursor position
     * Returns the line in question.
     */
    growLines: function(y) {
      if (y == null) y = this.curPos[1];
      /* Obtain contents and lines */
      var content = this.node.getElementsByTagName("pre")[0];
      var lines = content.children;
      /* Amend lines */
      var fullLength = this._offscreenLines + y + 1;
      while (lines.length < fullLength)
        content.appendChild(makeNode("div"));
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
        Array.prototype.forEach.call(lines[0].querySelectorAll(".cell"),
                                     this._cells.add.bind(this._cells));
        /* Actually dispose of line */
        content.removeChild(lines[0]);
        /* Decrement offscreen line count */
        this._offscreenLines--;
      }
      return lines[this._offscreenLines + y];
    },

    /* Return the cell immediately following the given one
     * If make is true, a new cell is created on demand.
     */
    _nextCell: function(cell, make) {
      var ret = cell.nextElementChild;
      if (! ret && make) {
        ret = this._cells.get();
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
      var children = line.children, cell;
      for (var i = 0; i <= x; i++) {
        cell = children[i];
        if (! cell) {
          cell = this._cells.get();
          line.appendChild(cell);
        }
        if (pad && ! cell.textContent) cell.textContent = " ";
      }
      return cell;
    },

    /* Move the cursor to the given coordinates or to the stored cursor
     * position */
    _placeCursor: function(x, y) {
      /* Resolve coordinates */
      if (x == null) x = this.curPos[0];
      if (y == null) y = this.curPos[1];
      /* Only access DOM when mounted */
      if (this.node) {
        var overflow = (x >= this.width);
        if (overflow) x = this.width - 1;
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
      }
      /* Write back cursor coordinates */
      this.curPos[0] = x;
      this.curPos[1] = y;
    },

    /* Place the cursor at the given coordinates
     * The position is clamped to fit into the window. */
    placeCursor: function(x, y) {
      if (x == null) x = this.curPos[0];
      if (y == null) y = this.curPos[1];
      if (x >= this.size[0]) x = this.size[0] - 1;
      if (y >= this.size[1]) y = this.size[1] - 1;
      if (x < 0) x = 0;
      if (y < 0) y = 0;
      this._placeCursor(x, y);
    },

    /* Move the cursor relatively to its current position */
    moveCursor: function(x, y) {
      this.placeCursor(this.curPos[0] + (x || 0),
                       this.curPos[1] + (y || 0));
    },

    /* Draw some text onto the output area
     * Writing starts at pos (falling back to the current cursor coordinates
     * when pos is null, or falling back at the x and y coordinate of the
     * cursor is the respective elements of pos are null), wraps lines as
     * appropriate, and stores the new cursor position unless noMove is true.
     * Control characters (including CR and LF) are rendered as normal text.
     */
    writeTextRaw: function(text, pos, noMove) {
      /* Resolve initial position */
      if (! pos) pos = [this.curPos[0], this.curPos[1]];
      if (pos[0] == null) pos[0] = this.curPos[0];
      if (pos[1] == null) pos[1] = this.curPos[1];
      /* Save decremented width; do not perform costy DOM manipulation if
       * no text given or not mounted */
      var tlm1 = text.length - 1;
      if (tlm1 >= 0 && this.node) {
        /* Get line array */
        var content = this.node.getElementsByTagName("pre")[0];
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
          cc.textContent = ch;
          /* Advance character */
          pos[0]++;
          if (pos[0] != this.size[0]) cc = this._nextCell(cc, true);
        }
      }
      /* Update cursor position if told to */
      if (! noMove) this._placeCursor(pos[0], pos[1]);
    }
  };

  /* Return export */
  return Terminal;
}();
