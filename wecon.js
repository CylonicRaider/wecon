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
      if (this.node) this.unmount();
      this.node = node;
      node.classList.add("wecon");
      node.innerHTML = "<pre></pre>";
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
        content.style.width = this.width + "ch";
        this.node.style.minWidth = content.offsetWidth + "px";
        curWidth = this.width;
      } else {
        /* Dynamic width */
        var sbSize = content.offsetWidth - content.clientWidth;
        var ch = parseFloat(measureStyle.width);
        curWidth = (this.node.offsetWidth - sbSize) / ch | 0;
        content.style.width = curWidth + "ch";
        this.node.style.minWidth = "";
      }
      if (this.height) {
        /* Fixed height */
        content.style.height = this.height + "em";
        this.node.style.minHeight = content.offsetHeight + "px";
        curHeight = this.height;
      } else {
        /* Dynamic height */
        var em = parseFloat(measureStyle.height);
        curHeight = this.node.offsetHeight / em | 0;
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
      this.placeCursor();
    },

    /* Add line nodes as necessary and possibly remove ones to maintain
     * the scroll buffer length */
    growLines: function() {
      /* Obtain contents and lines */
      var content = this.node.getElementsByTagName("pre")[0];
      var lines = content.children;
      /* Search cursor */
      var l, cursor = null;
      for (l = 0; l < lines.length; l++) {
        var cl = lines[l].getElementsByClassName("cursor");
        if (cl.length) {
          cursor = cl[0];
          break;
        }
      }
      /* Append lines as necessary */
      var fullLength;
      if (cursor) {
        /* Actual position of cursor node */
        var ep = l - (this.size[1] - lines.length);
        if (ep > this.curPos[1]) {
          /* If the cursor is below the expected position, lines have to be
           * added */
          fullLength = lines.length + ep - this.curPos[1];
        } else {
          /* Otherwise, just keep it as is */
          fullLength = lines.length;
        }
        /* Ensure the window is filled */
        if (fullLength < this.size[1]) fullLength = this.size[1];
      } else {
        fullLength = this.size[1];
      }
      while (lines.length < fullLength)
        content.appendChild(makeNode("div"));
      /* Strip lines up to scroll length */
      var sl = this.scrollback;
      if (! sl || sl < this.size[1]) sl = this.size[1];
      while (lines.length > sl) {
        /* Garbage-collect cells */
        Array.prototype.forEach.call(lines[0].querySelectorAll('.cell'),
                                     this._cells.add.bind(this._cells));
        /* Actually dispose of line */
        content.removeChild(lines[0]);
      }
    },

    /* Move the cursor to the given coordinates or to the stored cursor
     * position
     */
    placeCursor: function(x, y) {
      /* Resolve coordinates */
      if (x == null) x = this.curPos[0];
      if (y == null) y = this.curPos[1];
      /* Only access DOM when mounted */
      if (this.node) {
        /* Ensure that there are enough lines */
        this.growLines();
        /* Get line */
        var content = this.node.getElementsByTagName("pre")[0];
        var lines = content.children;
        var ln = lines[lines.length - (this.size[1] - y)];
        /* Get cell */
        var cells = ln.children;
        while (cells.length <= x)
          ln.appendChild(this._cells.get());
        /* Insert cursor */
        var cursor = content.getElementsByClassName("cursor")[0];
        if (! cursor) cursor = makeNode("span", "cursor");
        ln.insertBefore(cursor, cells[x] && cells[x].nextSibling);
      }
      /* Write back cursor coordinates */
      this.curPos[0] = x;
      this.curPos[1] = y;
    }
  };

  /* Return export */
  return Terminal;
}();
