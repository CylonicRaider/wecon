/* wecon -- Web Console emulator
 * https://github.com/CylonicRaider/wecon */

/* Hide implementation details in closure */
this.Terminal = function() {
  /* Regex for a string containing a single Unicode codepoint */
  var SINGLE_CODEPOINT = /^([^]|[\uD800-\uDBFF][\uDC00-\uDFFF])$/;

  /* Convenience function to create a DOM node */
  function makeNode(tagName, className) {
    var ret = document.createElement(tagName);
    if (className) ret.className = className;
    return ret;
  }

  /* Shallowly duplicate an object */
  function cloneObject(base) {
    var ret = {};
    for (var k in base) {
      if (! base.hasOwnProperty(k)) continue;
      ret[k] = base[k];
    }
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

    /* String.codePointAt shim */
    _toCodePoint: (String.codePointAt) ?
        function(s) { return s.codePointAt(0); } : function(s) {
      if (/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(s)) {
        return ((s.charCodeAt(0) & 0x3FF) << 10) +
               (s.charCodeAt(1) & 0x3FF) + 0x10000;
      } else if (s.length == 1) {
        return s.charCodeAt(0);
      } else {
        throw RangeError("Bad string for codepoint extraction: " + s);
      }
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
      /* Convert AtrrayBuffers to Uint8Arrays */
      if (input instanceof ArrayBuffer) input = new Uint8Array(input);
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

  /* Stateful escape sequence parser
   * Attributes:
   * init    : The initial state, an EscapeParser.State object. If null,
   *           characters are passed through without further processing.
   * cur     : The current state, an EscapeParser.State object. If null,
   *           the initial state is substituted upon the next character.
   * fallback: Fall-back callback for characters for which no processor
   *           is found. See the description of EscapeParser.State.fallback
   *           for invocation details.
   * state   : The current state object.
   */
  function EscapeParser() {
    this.init = null;
    this.cur = null;
    this.fallback = null;
    this.state = null;
  }

  EscapeParser.prototype = {
    /* Return (and create if necessary) the initial state node */
    first: function() {
      if (! this.init) {
        this.init = new EscapeParser.State();
      }
      return this.init;
    },

    /* Convenience wrapper for this.first().on(...) */
    on: function() {
      var first = this.first();
      return first.on.apply(first, arguments);
    },

    /* Convenience wrapper for this.first().at(...) */
    at: function() {
      var first = this.first();
      return first.at.apply(first, arguments);
    },

    /* Process a character (or multiple)
     * It is the caller's obligation to maintain surrogate pairs together.
     */
    process: function(s) {
      var slm1 = s.length - 1;
      for (var i = 0; i <= slm1; i++) {
        /* Extract character */
        var ch = s[i];
        if (/[\uD800-\uDBFF]/.test(ch) && i < slm1 &&
            /[\uDC00-\uDFFF]/.test(s[i + 1]))
          ch += s[++i];
        /* Possibly reset to initial state */
        if (! this.cur) {
          this.cur = this.init;
          this.state = {};
          if (this.cur) this.cur._changed(this.state, null);
        }
        /* Transition to next state */
        var ok = false;
        if (this.cur) {
          var res = this.cur._run(this.state, ch);
          if (res.ok) {
            /* Successor found */
            ok = true;
            this.cur = res.next;
            if (this.cur) {
              /* Call post-change hook */
              for (;;) {
                var ns = this.cur._changed(this.state, ch);
                if (ns == null) break;
                if (Array.isArray(ns)) {
                  this.cur = ns[0] || this.cur;
                  ch = ns[1] || null;
                } else {
                  this.cur = ns;
                  ch = null;
                }
              }
            } else {
              /* Finish reset */
              this.state = null;
            }
          }
        }
        /* If transition failed, reset */
        if (! ok) {
          /* Last chance to revive */
          if (this.fallback) {
            this.cur = this.fallback.call(this.state, ch, null) || null;
          } else {
            this.cur = null;
          }
          /* Finish reset */
          if (! this.cur) this.state = null;
        }
      }
    }
  };

  /* A node of the EscapeParser state graph
   * State transitions are caused by single "characters" (which can also be
   * surrogate pairs). For each character, the transition table of the
   * current state is checked, if it does contain a mapping for the
   * character, the new state is assumed; if it does not contain a mapping
   * for the current character, the fallback callback is invoked (if
   * present), which can provide another state to transition to; if it does
   * not, the parser-level global fallback is asked. After each transition,
   * the callback of the new state is invoked (if present). If no transition
   * if found for the current character (and in the very beginning), the
   * parser is reset.
   * Each callback is invoked with a "state object" that is changed to a
   * freshly allocated object upon each reset; see the attribute descriptions
   * for details.
   * Attributes:
   * callback  : A function that is invoked when this state is transitioned
   *             to. Called with the this variable set to the state object,
   *             which is either freshly created when the initial state is
   *             reset to or retained from the last operations, and the
   *             character that caused the transition (null if resetting to
   *             the initial state) and the EscapeParser.State instance the
   *             callback belongs to. Returns a new state to switch to (the
   *             callback whereof will be called as well, etc), a 2-array
   *             [state, ch] of a state and a synthetic character to pass to
   *             the next state, or null to stay at the current state.
   * successors: A character->state mapping of successor states.
   * fallback  : A callback that is invoked when no state from the successor
   *             mapping matched. The return value (if true) is taken to be
   *             be the new state; if it is not, processing proceeds with the
   *             parser-level global fallback, for which the same semantics
   *             apply. The arguments are the same as for callback, except
   *             that the state parameter is null for the global fallback.
   */
  EscapeParser.State = function(callback, fallback) {
    this.callback = callback || null;
    this.successors = {};
    this.fallback = fallback || null;
  };

  EscapeParser.State.prototype = {
    /* Handle the transition to this state */
    _changed: function(state, ch) {
      if (! this.callback) return null;
      return this.callback.call(state, ch, this);
    },

    /* Process the given character WRT the given state object and return how
     * to proceed
     */
    _run: function(state, ch) {
      var succ = this.successors[ch];
      if (succ) return {ok: true, next: succ};
      if (this.fallback) {
        succ = this.fallback.call(state, ch, this) || null;
        if (succ) return {ok: true, next: succ};
      }
      return {ok: false};
    },

    /* Reset the callback, successors, and fallback of this instance */
    clear: function() {
      this.callback = null;
      this.successors = {};
      this.fallback = null;
    },

    /* Install a handler for some amount of characters
     * If handler is a function, a new EscapeParser.State instance is created
     * with handler as the callback.
     * The new state (be it handler or newly-created) is returned.
     */
    on: function(s, handler, fallback) {
      /* Convert functions into nodes */
      if (typeof handler == "function" || handler == null)
        handler = new EscapeParser.State(handler);
      if (fallback)
        handler.fallback = fallback;
      /* Parse character specification */
      var chars = [];
      var ch = null, slm1 = s.length - 1, groupStart = null;
      for (var i = 0; i <= slm1; i++) {
        /* Check for groups */
        if (s[i] == "-" && i > 0 && i < slm1) {
          groupStart = ch;
          continue;
        }
        /* Extract character */
        var ch = s[i];
        if (/[\uD800-\uDBFF]/.test(ch) && i < slm1 &&
            /[\uDC00-\uDFFF]/.test(s[i + 1]))
          ch += s[++i];
        /* Check for groups */
        if (groupStart != null) {
          /* Insert character range */
          var fromCP = UTF8Dec.prototype._fromCodePoint;
          var toCP = UTF8Dec.prototype._toCodePoint;
          var from = toCP(groupStart), to = toCP(ch);
          if (from > to) {
            var temp = from;
            from = to;
            to = temp;
          }
          for (var j = from + 1; j < to; j++) {
            chars.push(fromCP(j));
          }
          /* Reset group mode */
          groupStart = null;
        }
        /* Just append character */
        chars.push(ch);
      }
      /* Assign handler to each character */
      chars.forEach(function(el) {
        this.successors[el] = handler;
      }.bind(this));
      /* Return result for chaining */
      return handler;
    },

    /* Return the successor state for the given character or a newly-created
     * no-op state if none */
    at: function(ch) {
      var ret = this.successors[ch];
      if (! ret) {
        ret = new EscapeParser.State();
        this.successors[ch] = ret;
      }
      return ret;
    }
  };

  /* Two-stage text (and miscellaneous action) accumulator */
  function TextAccumulator() {
    this._text = "";
    this._queue = [];
  }

  TextAccumulator.prototype = {
    /* Queue some text
     * Consequent pieces of text are coalesced. */
    addText: function(text) {
      this._text += text;
    },

    /* Queue a function call
     * func is the function to call,
     * self is the this argument to pass,
     * args is an array of position arguments to pass.
     */
    addCall: function(func, self, args) {
      if (this._text) {
        this._queue.push(this._text);
        this._text = "";
      }
      this._queue.push([func, self, args]);
    },

    /* Return the current queue contents and clear the queue */
    pop: function() {
      if (this._text) {
        this._queue.push(this._text);
        this._text = "";
      }
      var ret = this._queue;
      this._queue = [];
      return ret;
    },

    /* Flush the queue, running any functions from it
     * Text is processed by the callback as provided by the caller,
     * with assignments similar to addCall. The piece of text to be
     * processed is passed as the only positional argument of func. */
    run: function(func, self) {
      this.pop().forEach(function(el) {
        if (typeof el == "string") {
          func.call(self, el);
        } else {
          el[0].apply(el[1], el[2] || []);
        }
      });
    },

    /* Return whether there is nothing queued */
    isEmpty: function() {
      return (! this._text && ! this._queue.length);
    }
  };

  /* Actual terminal emulator.
   * options specifies parameters of the terminal (all of which are mirrored
   * by same-named attributes):
   * width      : The terminal should have the given (fixed) width; if not
   *              set, it will adapt to the container.
   * height     : Fixed height.
   * bell       : An <audio> element (or anything having a play() method)
   *              that should be invoked for a BEL character.
   * visualBell : If true, bells will be indicated by shortly flashing the
   *              terminal output, without invoking bell ever.
   * scrollback : Length of the scrollback buffer. When not set or less than
   *              the current height, all lines "above" the display area are
   *              immediately discarded; when set to positive infinity,
   *              arbitrarily many lines are stored.
   * oninput    : A callback called every time there is new input, unless
   *              there is already data buffered. The only parameter is a
   *              DOM Event Object with the type set to "input" and the
   *              target to the Terminal instance; the return value is
   *              ignored. Use the read() method to extract queued input.
   * Additional attributes:
   * node       : The DOM node the terminal is residing in.
   * size       : The actual size of the terminal as a [width, height] array
   *              (in character cells), or null if never shown yet.
   * curPos     : The current cursor position as an (x, y) array. Both
   *              coordinates must be not less than zero; the y coordinate
   *              must be less than the height and the x coordinate must be
   *              not greater (!) than the width. The initial value is
   *              [0, 0].
   *              NOTE (explicitly) that the x coordinate may be equal to the
   *                   width.
   *              Changing the attribute will not update the DOM; invoke the
   *              placeCursor() method for that.
   * curFg      : The current foreground color index, or null if the default
   *              is to be used.
   * curBg      : The current background color index, or null if the default
   *              is to be used.
   * curAttrs   : The current display attributes as a bitmask of the
   *              constants Terminal.ATTR.*.
   * tabStops   : An object mapping tab stop indices to true values. The
   *              values are assigned no semantics (and are frankly unlikely
   *              to be), aside from being truthy.
   * scrollReg  : The current scrolling region as a [top, bottom] array (top
   *              inclusively, bottom exclusively), or null if there is no
   *              explicit scrolling region. The scrollback buffer is filled
   *              by lines scrolling off the top only if there is no
   *              scrolling region or the top is at row 0.
   * mouseTrack : Mouse tracking mode (0 = none; 1 = X10 style; 2 = X11
   *              style; 3 = X11 drag tracking; 4 = X11 motion tracking). See
   *              xterm docs (NOTE that those use different terminology).
   * mouseEncode: Mouse tracking coordinate encoding (0 = truncate to single
   *              octet; 1 = encode as UTF-8; 2 = emit "CSI <" sequence). See
   *              xterm docs.
   * modes      : An object of mode flags. See Terminal.DEFAULT_MODES for
   *              default assignments.
   * savedAttrs : The last attribute save as recorded by saveAttributes()
   *              (unless prevented).
   * parser     : The EscapeParser instance responsible for parsing escape
   *              sequences. Exposed to allow registering new handlers; if
   *              other parts of the API are used, undefined behavior occurs.
   * csiHandlers: A code->function mapping from "effective function strings"
   *              to callbacks powering CSI escape sequences. See addCSI()
   *              and handleCSI() for details.
   */
  function Terminal(options) {
    if (! options) options = {};
    this.width = options.width;
    this.height = options.height;
    this.bell = options.bell;
    this.visualBell = options.visualBell;
    this.scrollback = options.scrollback;
    this.oninput = null;
    this.node = null;
    this.savedAttrs = null;
    this.parser = new EscapeParser();
    this.csiHandlers = {};
    this._currentScreen = 0;
    this._decoder = new UTF8Dec();
    this._accum = new TextAccumulator();
    this._keydown = this.keydown.bind(this);
    this._keyup = this.keyup.bind(this);
    this._mousemove = this.mousemove.bind(this);
    this._mousedown = this.mousedown.bind(this);
    this._mouseup = this.mouseup.bind(this);
    this._mousewheel = this.mousewheel.bind(this);
    this._focusin = this.focusin.bind(this);
    this._focusout = this.focusout.bind(this);
    this._resize = this.resize.bind(this);
    this._lastKey = null;
    this._lastMouse = null;
    this._pendingBells = [];
    this._pendingUpdate = [null, null];
    this._queuedInput = [];
    this._initParser();
    this._initControls();
    this.reset(false);
  }

  /* Text encoding of an RGB triplet for color processing */
  var RGB_COLOR = /^rgb-(\d+)-(\d+)-(\d+)$/;
  var RGB_FG = /\bfg-rgb-\d+-\d+-\d+\b/;
  var RGB_BG = /\bbg-rgb-\d+-\d+-\d+\b/;

  /* Helper that translates an RGB attribute to a CSS declaration */
  function parseRGB(clr) {
    if (! clr) return "";
    var m = RGB_COLOR.exec(clr);
    if (! m) return "";
    return "rgb(" + m[1] + "," + m[2] + "," + m[3] + ")";
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
    512: "dblunderline",
  };

  /* Default mode flags */
  Terminal.DEFAULT_MODES = {
    applicationKeypad: false, /* Send editing functions rather than digits */
    displayControls  : false, /* Display certain control characters */
    insert           : false, /* Insert characters instead of overwriting */
    lfAtCR           : false, /* Follow a CR typed by the user with a LF */
    applicationCursor: false, /* Send ^[O rather than ^[[ for cursor keys */
    wideTerm         : false, /* 132-column mode. No effect. */
    reverseVideo     : false, /* Reverse all video (additionally) */
    origin           : false, /* Origin mode: Home at scrolling region */
    autowrap         : true,  /* Automatically wrap lines when overflowing */
    autoRepeat       : true,  /* Suppress key auto-repetition if off */
    cursorVisible    : true,  /* Whether the cursor should be visible */
    trackFocus       : false, /* Send escape sequences on focus changes */
  };

  /* Mapping from escape sequence parameter strings to mode names as used
   * by Terminal */
  Terminal.MODE_CODES = {
    /* applicationKeypad is controlled differently */
    "3"    : "displayControls",
    "4"    : "insert",
    "20"   : "lfAtCR",
    "?1"   : "applicationCursor",
    "?3"   : "wideTerm",
    "?5"   : "reverseVideo",
    "?6"   : "origin",
    "?7"   : "autowrap",
    "?8"   : "autoRepeat",
    "?25"  : "cursorVisible",
    "?1004": "trackFocus"
  };

  /* Try to parse a (non-private) parameter string according to ECMA-48 */
  Terminal.parseParamString = function(ps) {
    return ps.split(";").map(function(el) {
      if (! el) {
        return null;
      } else if (/^[0-9]+$/.test(el)) {
        return parseInt(el, 10);
      } else {
        return el;
      }
    });
  };

  Terminal.prototype = {
    /* Initialize the internal parser
     * Called internally. */
    _initParser: function() {
      /* Helper */
      function callAndReturn(func, self, args) {
        return function() {
          self._accum.addCall(func, self, args);
          return first;
        };
      }
      /* Capture current this in closure */
      var self = this;
      /* Set up parser */
      var first = this.parser.first();
      first.clear();
      first.on("\0-\x1f\x7f-\x9f", function(ch) {
        self._accum.addCall(self._handleCC, self, [ch]);
        return first;
      });
      var esc = first.on("\x1b");
      esc.on("7", callAndReturn(self.saveAttributes, self));
      esc.on("8", callAndReturn(self.restoreAttributes, self));
      /* FIXME: Ignore any character after ECMA-35 character set
       *        designators. */
      esc.on(" !\"#%&()*+./-", null, function() { return first; });
      esc.on("@-_", function(ch) {
        var cc = ch.charCodeAt(0) + 64;
        var cs = String.fromCharCode(cc);
        return [first.successors[cs] || first, cs];
      });
      esc.on("`-~"); // Ignore.
      esc.on("c", callAndReturn(self.reset, self));
      var csi = first.on("\x9b", function() {
        this.csi = true;
        this.params = "";
        this.func = "";
      });
      esc.on(">", callAndReturn(self.setMode, self,
                                ["applicationKeypad", false]));
      esc.on("=", callAndReturn(self.setMode, self,
                                ["applicationKeypad", true]));
      var csiP = csi.on("0-?", function(ch) {
        this.params += ch;
      });
      var csiI = csi.on(" -/", function(ch) {
        this.func += ch;
      });
      var csiF = csi.on("@-~", function(ch) {
        this.func += ch;
        var params = {params: this.params, func: this.func};
        self._accum.addCall(self.handleCSI, self, [params]);
        delete this.csi;
        delete this.params;
        delete this.func;
        return first;
      });
      csiP.on("0-?", csiP);
      csiP.on(" -/", csiI);
      csiP.on("@-~", csiF);
      csiI.on(" -/", csiI);
      csiI.on("@-~", csiF);
      var strC = first.on("\x90\x9d-\x9f", function(ch) {
        if (/[\x90\x9d-\x9f]/.test(ch))
          this.string = ch;
      }, function(ch) {
        if (/[\0-\x07\x0e-\x1f\x7f]/.test(ch))
          return null;
        this.string += ch;
        return strC;
      });
      var strST = strC.on("\x07\x9c", function() {
        self._accum.addCall(self.handleCSTR, self, [this.string]);
        delete this.string;
        return first;
      });
      strC.on("\x1b").on("\\", strST);
      var strS = first.on("\x98", function(ch) {
        if (ch == "\x98")
          this.string = ch;
      }, function(ch) {
        this.string += ch;
        return strS;
      });
      strS.on("\x9c", strST);
      strS.on("\x1b", null, function(ch) {
        this.string += "\x1b" + ch;
        return strS;
      }).on("\\", strST);
      this.parser.fallback = function(ch) {
        delete this.csi;
        delete this.params;
        delete this.func;
        delete this.string;
        if (/[\x18\x1a]/.test(ch) && ! self.modes.displayControls) {
          /* NOP */
        } else {
          self._accum.addText(ch);
        }
      };
    },

    /* Install handlers for the usually recognized CSI sequences
     * Called internally.
     */
    _initControls: function() {
      /* Helpers */
      var ia = function(code, func, insert) {
        this.addCSI(code, function(params) {
          var arr = params.paramArray;
          if (! arr || ! arr.length)
            arr = (insert) ? [null] : [];
          func.call(this, arr);
        });
      }.bind(this);
      var ih = function(code, func) {
        this.addCSI(code, function(params) {
          func.apply(this, params.paramArray || []);
        });
      }.bind(this);
      var ip = function(code, func, insert) {
        this.addCSI(code, function(params) {
          var arr = params.paramArray;
          if (! arr || ! arr.length)
            arr = (insert) ? [null] : [];
          arr.forEach(function(el) {
            func.call(this, el);
          }.bind(this));
        });
      }.bind(this);
      var is = function(code, func) {
        this.addCSI(code, function(params) {
          func.call(this, params.params);
        });
      }.bind(this);
      /* Actual handlers */
      ih("@", function(n) { this.spliceCharacters(null, 0, n || 1); });
      ih("A", function(n) { this.navigateCursor(0, -(n || 1)); });
      ih("B", function(n) { this.navigateCursor(0, n || 1); });
      ih("C", function(n) { this.moveCursor(n || 1, 0); });
      ih("D", function(n) { this.moveCursor(-(n || 1), 0); });
      ih("E", function(n) { this.navigateCursor(0, n || 1);
                            this.moveCursor(0, null); });
      ih("F", function(n) { this.navigateCursor(0, -(n || 1));
                            this.moveCursor(0, null); });
      ih("G", function(n) { this.moveCursor(n - 1, null); });
      ih("H", function(y, x) {
        this.placeCursor((x || 1) - 1, (y || 1) - 1); });
      ih("I", function(n) { this.tabulate(1); });
      ip("J", function(p) { if (p == null) p = 0;
                            this.eraseDisplay((p == 0 || p == 2),
                                              (p == 1 || p == 2),
                                              (p == 3)); }, true);
      ip("K", function(p) { if (p == null) p = 0;
                            this.eraseLine((p == 0 || p == 2),
                                           (p == 1 || p == 2)); }, true);
      ih("L", function(n) { this.spliceLines(null, 0, n || 1); });
      ih("M", function(n) { this.spliceLines(null, n || 1, 0); });
      /* N (EF - ERASE IN FIELD) and O (EA - ERASE IN AREA) are N/I */
      ih("P", function(n) { this.spliceCharacters(null, n || 1, 0); });
      /* Other not implemented functions are henceforth not mentioned */
      ih("X", function(n) { this.spliceCharacters(null, n || 1, n || 1); });
      ih("a", function(n) { this.moveCursor(n || 1, 0); });
      ih("d", function(n) { this.moveCursor(null, n || 1); });
      ih("e", function(n) { this.navigateCursor(0, n || 1); });
      ih("f", function(y, x) { this.moveCursor(x - 1, y - 1); });
      ip("g", function(p) {
        if (g == 0) this.editTabStops(this.curPos[0], null);
        if (g == 3) this.editTabStops(this.getTabStops(), null); }, true);
      ih("h", function(p) { this.setMode(p, true); });
      ih("l", function(p) { this.setMode(p, false); });
      ia("m", this._handleSGR); /* Outlined because of complexity */
      is("n", this._handleDSR); /* Outlined because of complexity as well */
      ih("r", function(t, b) { this.setScrollRegion(t - 1, b - 1);
                               this.placeCursor(0, 0); });
      ih("s", function() { this.saveAttributes(); });
      ih("u", function() { this.restoreAttributes(); });
      ih("`", function(n) { this.moveCursor(n || 1, null); });
      is("?h", function(p) { this.setMode(p, true); });
      is("?l", function(p) { this.setMode(p, false); });
      is("?n", this._handleDSR); /* Also reply to private-mode DSR's. */
    },

    /* Reset the entire terminal or the current screen */
    reset: function(full) {
      if (full && this.node) {
        this.node.innerHTML = "";
        this.selectScreen(0);
      } else {
        this.size = null;
        this.curPos = [0, 0];
        this.curFg = null;
        this.curBg = null;
        this.curAttrs = 0;
        this.tabStops = {};
        this.scrollReg = null;
        this.mouseTrack = 0;
        this.mouseEncode = 0;
        this.modes = cloneObject(Terminal.DEFAULT_MODES);
        this._offscreenLines = 0;
        if (this.node) {
          var cn = this._contentNode();
          if (cn) {
            cn.innerHTML = "";
            this._prepareAttrs()(cn);
          }
          this.resize(true);
        }
      }
    },

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
      node.addEventListener("keydown", this._keydown);
      node.addEventListener("keyup", this._keyup);
      node.addEventListener("mousemove", this._mousemove);
      node.addEventListener("mousedown", this._mousedown);
      node.addEventListener("mouseup", this._mouseup);
      node.addEventListener("wheel", this._mousewheel);
      node.addEventListener("focus", this._focusin);
      node.addEventListener("blur", this._focusout);
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
        this.node.removeEventListener("keydown", this._keydown);
        this.node.removeEventListener("keyup", this._keyup);
        this.node.removeEventListener("mousemove", this._mousemove);
        this.node.removeEventListener("mousedown", this._mousedown);
        this.node.removeEventListener("mouseup", this._mouseup);
        this.node.removeEventListener("wheel", this._mousewheel);
        this.node.removeEventListener("focus", this._focusin);
        this.node.removeEventListener("blur", this._focusout);
        window.removeEventListener("resize", this._resize);
      }
      this._oldSize = null;
      this.node = null;
    },

    /* Throw an error if the terminal is not mounted */
    checkMounted: function() {
      if (! this.node) throw new Error("Terminal not mounted");
    },

    /* React to a key press event */
    keydown: function(event) {
      /* Warn on unsupported platforms */
      // There is no reliable way to determine which key was pressed. *arrgh*
      if (typeof event.key != "string") {
        console.warn("Swallowing key event:", event);
        return;
      }
      /* Honor auto-repeat suppression */
      if (! this.modes.autoRepeat && this._lastKey &&
          event.code == this._lastKey) return;
      this._lastKey = event.code;
      /* Result */
      var res = null, shiftMask = true;
      /* Character input */
      if (SINGLE_CODEPOINT.test(event.key)) {
        if (event.ctrlKey && ! event.metaKey) {
          /* Handle Ctrl+... */
          // Since only some ASCII characters are handled like that, we don't
          // need fancy Unicode codepoints.
          var ch = event.key.charCodeAt(0);
          // Bail out for Ctrl-Shift-Letter sequences to allow some keyboard
          // shortcuts to function.
          if (/[A-Z]/.test(event.key)) return;
          /* Transform letters to uppercase for ASCII magic */
          if (/[a-z]/.test(event.key)) ch ^= 0x20;
          if (ch == 0x20) {
            // Ctrl-Space. Don't ask me why.
            res = "\0";
          } else if (ch >= 0x40 && ch <= 0x5F) {
            res = String.fromCharCode(ch - 0x40);
          } else {
            res = event.key;
          }
        } else if (event.metaKey) {
          /* Not defined; allow browser/OS to handle that */
        } else {
          res = event.key;
        }
        /* Translate keypad keys */
        if (this.modes.applicationKeypad && /^Numpad/.test(event.code)) {
          res = {
            " ": "\x1bO ", "\t": "\x1bO\t", "\r": "\x1bO\r", "/": "\x1bOo",
            "*": "\x1bOj", "-": "\x1bOm", "+": "\x1bOk", ".": "\x1b[3~",
            ",": "\x1bOl", "=": "\x1bOX", "0": "\x1b[2~", "1": "\x1bOF",
            "2": "\x1b[B", "3": "\x1b[6~", "4": "\x1b[D", "5": "\x1b[E",
            "6": "\x1b[C", "7": "\x1bOH", "8": "\x1b[A", "9": "\x1b[5~"
          }[res] || res;
        }
      } else {
        /* Function keys */
        // And now welcome to the Marvellous Diverse Historically-Grown Lands
        // of Function Keys et alii!
        switch (event.key) {
          case "Space"     : res = " "; break;
          case "Tab"       : res = "\t"; break;
          case "Escape"    : res = "\x1b"; break;
          case "Enter"     : res = "\r"; break;
          case "Backspace" : res = "\x7f"; break;
          case "F1"        : res = "\x1bOP"; break;
          case "F2"        : res = "\x1bOQ"; break;
          case "F3"        : res = "\x1bOR"; break;
          case "F4"        : res = "\x1bOS"; break;
          case "F5"        : res = "\x1b[15~"; break;
          case "F6"        : res = "\x1b[17~"; break;
          case "F7"        : res = "\x1b[18~"; break;
          case "F8"        : res = "\x1b[19~"; break;
          case "F9"        : res = "\x1b[20~"; break;
          case "F10"       : res = "\x1b[21~"; break;
          case "F11"       : res = "\x1b[23~"; break;
          case "F11"       : res = "\x1b[24~"; break;
          case "Insert"    : res = "\x1b[2~"; break;
          case "Delete"    : res = "\x1b[2~"; break;
          case "PageUp"    : res = "\x1b[2~"; break;
          case "PageDown"  : res = "\x1b[2~"; break;
          case "Home"      : res = "\x1b[H"; break;
          case "End"       : res = "\x1b[F"; break;
          case "ArrowUp"   : res = "\x1b[A"; break;
          case "ArrowDown" : res = "\x1b[B"; break;
          case "ArrowRight": res = "\x1b[C"; break;
          case "ArrowLeft" : res = "\x1b[D"; break;
        }
        // HACK to compensate for Shift-Tab not identified.
        if (event.code == "Tab") res = "\t";
        /* Special-case Shift-Tab and Shift-Return */
        if (/[\t\r]/.test(res) && event.shiftKey) {
          res = (res == "\t") ? "\x1b[Z" : "\x1bOM";
          shiftMask = false;
        }
        /* Translate cursor keys */
        if (this.modes.applicationCursor && /^\x1b\[[ABCDHF]$/.test(res)) {
          res = res.replace(/\[/, "O");
        }
      }
      /* Process modifiers */
      if (SINGLE_CODEPOINT.test(res)) {
        /* Only Alt-Sends-Escape :( */
        if (event.altKey) res = "\x1b" + res;
      } else if (res) {
        /* Modifier bitmask */
        var modMask = ((!! event.metaKey) << 4) +
                      ((!! event.altKey) << 3) +
                      (((!! event.shiftKey) && shiftMask) << 2) +
                      (!! event.ctrlKey) + 1;
        if (modMask != 1) {
          /* Transform SS3 into CSI 1 */
          res = res.replace(/O/, "[1");
          /* Add modifiers */
          if (res.length == 3) {
            res = res.substring(0, 2) + modMask + res.substring(2);
          } else {
            var l = res.length;
            res = res.substring(0, l - 1) + ";" + modMask +
                  res.substring(l - 1);
          }
        }
      }
      /* Honor lfAtCR mode */
      if (this.modes.lfAtCR && res == "\r") res += "\n";
      /* Send result to outside */
      if (res) {
        this._queueInput(res);
        /* Grab event */
        event.preventDefault();
        event.stopPropagation();
      }
    },

    /* Handle a released key
     * Does not really do much.
     */
    keyup: function() {
      this._lastKey = null;
    },

    /* Handle mouse motion event */
    mousemove: function(event) {
      if (this.mouseTrack <= 2 || event.target == this.node)
        return;
      this._sendMouse(event, "moved");
    },

    /* Handle mouse button press event */
    mousedown: function(event) {
      if (! this.mouseTrack || event.target != this._contentNode())
        return;
      this._sendMouse(event, "pressed");
    },

    /* Handle mouse button release event */
    mouseup: function(event) {
      if (this.mouseTrack <= 1 || event.target != this._contentNode())
        return;
      this._sendMouse(event, "released");
    },

    /* Handle mouse wheel event */
    mousewheel: function(event) {
      if (this.mouseTrack <= 1 || event.target != this._contentNode() ||
          event.deltaY == 0)
        return;
      this._sendMouse(event, (event.deltaY < 0) ? "scrollup" : "scrolldown");
    },

    /* Common code for all mouse event handlers */
    _sendMouse: function(event, extra) {
      /* Bail out when this event is not tracked */
      if (extra == "moved" && this.mouseTrack == 3 && ! event.buttons & 7)
        return;
      /* Resolve position */
      var cnt = this._contentNode();
      var rect = cnt.getBoundingClientRect();
      var measure = getComputedStyle(cnt, "::before");
      var x = (event.clientX - rect.left) / parseInt(measure.width) | 0;
      var y = (event.clientY - rect.top) / parseInt(measure.height) | 0;
      if (x < 0 || x >= this.size[0] || y < 0 || y >= this.size[1])
        return;
      /* Resolve button */
      var btn, released = null;
      if (extra == "pressed" || extra == "released") {
        btn = event.button;
        if (btn > 2) return;
        released = (extra == "released");
      } else if (extra == "moved") {
        if (event.buttons & 1) {
          btn = 0;
        } else if (event.buttons & 2) {
          btn = 2;
        } else if (event.buttons & 4) {
          btn = 1;
        } else if (this.mouseTrack < 4) {
          return;
        } else {
          btn = 3;
        }
      } else if (extra == "scrollup") {
        btn = 4;
      } else if (extra == "scrolldown") {
        btn = 5;
      }
      /* Assemble packet to send */
      var packet;
      if (this.mouseTrack == 1) {
        packet = [btn, x, y];
      } else {
        if (btn >= 4) btn = (btn - 4) | 64;
        btn |= (!! event.shiftKey) << 2 | (!! event.ctrlKey) << 3 |
               (!! event.altKey) << 4;
        if (extra == "moved") btn |= 32;
        packet = [btn, x, y, released];
        /* Discard duplicate events */
        if (this._lastMouse &&
            packet[0] == this._lastMouse[0] &&
            packet[1] == this._lastMouse[1] &&
            packet[2] == this._lastMouse[2] &&
            packet[3] == this._lastMouse[3]) return;
        this._lastMouse = packet;
      }
      /* Encode packet */
      var coded;
      if (this.mouseEncode == 0) {
        /* Truncated raw bytes */
        if (released) packet[0] |= 3;
        coded = new Uint8Array(6);
        coded[0] = 0x1b; // ESC
        coded[1] = 0x5b; // [
        coded[2] = 0x4d; // M
        coded[3] = packet[0] + 0x20;
        coded[4] = Math.min(packet[1] + 0x21, 0xFF);
        coded[5] = Math.min(packet[2] + 0x21, 0xFF);
      } else if (this.mouseEncode == 1) {
        /* UTF-8 encoding */
        if (released) packet[0] |= 3;
        coded = "\x1b[M" + String.fromCharCode(packet[0] + 0x20) +
                UTF8Dec.prototype._fromCodePoint(packet[1] + 0x21) +
                UTF8Dec.prototype._fromCodePoint(packet[2] + 0x21);
      } else if (this.mouseEncode == 2) {
        /* Special CSI sequence */
        coded = "\x1b[<" + packet[0] + ";" + (packet[1] + 1) + ";" +
                (packet[2] + 1) + ((released) ? "m" : "M");
      } else {
        throw new Error("Bad internal state");
      }
      /* Send! */
      this._queueInput(coded);
    },

    /* Handle focus entering the terminal */
    focusin: function() {
      if (this.modes.trackFocus) this._queueInput("\x1b[I");
    },

    /* Handle focus leaving the terminal */
    focusout: function() {
      if (this.modes.trackFocus) this._queueInput("\x1b[O");
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
      /* Update tab stops */
      var ow = (this.size) ? this.size[0] : 0;
      var tbd = [], tba = [];
      for (var x = ow; x >= curWidth; x--) {
        if (this.tabStops[x]) tbd.push(x);
      }
      for (var x = ow; x < curWidth; x++) {
        if (x && x % 8 == 0) tba.push(x);
      }
      this.editTabStops(tbd, tba);
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
      /* Prepare for auto-scroll */
      var scroll = this._prepareScroll();
      /* Determine necessary line amount */
      var content = this._contentNode();
      var lines = content.children;
      var rl = lines.length;
      if (this._offscreenLines)
        rl = this._offscreenLines + this.size[1];
      /* Remove overflowing lines */
      while (lines.length > rl) {
        /* Dispose of line */
        content.removeChild(content.lastElementChild);
      }
      /* Add new lines as padding */
      while (lines.length < rl) {
        content.appendChild(makeNode("div"));
      }
      /* Update cursor node */
      this._placeCursor();
      /* Auto-scroll */
      scroll();
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
        var f = this.tabStops.hasOwnProperty.bind(this.tabStops);
        var ts = Object.keys(this.tabStops).filter(f);
        node.setAttribute("data-state", JSON.stringify({
          pos: this.curPos, fg: this.curFg, bg: this.curBg,
          attrs: this.curAttrs, offscreenLines: this._offscreenLines,
          tabStops: ts}));
        node.classList.remove("visible");
      }
      /* Thaw data from new node, or allocate one */
      node = this.node.querySelector("pre[data-screen-id=\"" + id + "\"]");
      if (node) {
        /* Restore parameters */
        var state = {};
        try {
          state = JSON.parse(node.getAttribute("data-state"));
        } catch (e) {}
        this.curPos = state.pos || [0, 0];
        this.curFg = state.fg || null;
        this.curBg = state.bg || null;
        this.curAttrs = +state.attrs;
        this._offscreenLines = +state.offscreenLines;
        this.tabStops = {};
        (state.tabStops || []).forEach(function(el) {
          this.tabStops[el] = true;
        }.bind(this));
        /* Remove old values */
        node.removeAttribute("data-state");
        node.classList.add("visible");
        /* Update current ID */
        this._currentScreen = id;
        /* Update reversed-video state */
        this.reverseVideo();
        /* Update node size */
        this.resize(true);
      } else {
        /* Allocate new node */
        node = makeNode("pre");
        node.setAttribute("data-screen-id", id);
        this.node.appendChild(node);
        node.classList.add("visible");
        /* Update current ID */
        this._currentScreen = id;
        /* Reset */
        this.reset(false);
      }
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

    /* Remove all cells from the given line
     * Convenience wrapper around _cellRange() and removeChild().
     */
    _clearLine: function(line) {
      this._cellRange(line).forEach(line.removeChild.bind(line));
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
      var attrs = this._prepareAttrs(content, true);
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
        /* Dispose of line */
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
      var ret = cell.nextElementSibling;
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
      var attrs = this._prepareAttrs(line, true);
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
      /* Extract some line */
      var line = this.growLines(y);
      /* Remove old cursor */
      var cursor = line.parentNode.getElementsByClassName("cursor")[0];
      if (cursor) {
        cursor.classList.remove("cursor");
        cursor.classList.remove("overflow");
      }
      /* Write back cursor coordinates */
      this.curPos[0] = x;
      this.curPos[1] = y;
      /* Abort if cursor invisible */
      if (! this.modes.cursorVisible) return;
      /* Extract current cell */
      var cell = this.growCells(line, x, false);
      /* Install new cursor */
      cell.classList.add("cursor");
      if (overflow) cell.classList.add("overflow");
    },

    /* Place the cursor at the given coordinates
     * The position is clamped to fit into the window. */
    placeCursor: function(x, y) {
      var p = this._resolvePosition([x, y]);
      if (this.modes.origin && this.scrollReg) {
        p[1] += this.scrollReg[0];
        if (p[1] >= this.scrollReg[1]) p[1] = this.scrollReg[1] - 1;
      }
      this._placeCursor(p[0], p[1]);
    },

    /* Move the cursor relatively to its current position */
    moveCursor: function(dx, dy) {
      var p = this._resolvePosition([this.curPos[0] + (dx || 0),
                                     this.curPos[1] + (dy || 0)]);
      if (this.modes.origin && this.scrollReg) {
        p[1] += this.scrollReg[0];
        if (p[1] >= this.scrollReg[1]) p[1] = this.scrollReg[1] - 1;
      }
      this._placeCursor(p[0], p[1]);
    },

    /* Move the cursor relatively whilst respecting the scrolling region */
    navigateCursor: function(dx, dy) {
      if (! this.scrollReg) {
        this.moveCursor(dx, dy);
        return;
      }
      var nx = this.curPos[0] + (dx || 0);
      var ny = this.curPos[1] + (dy || 0);
      if (this.curPos[1] < this.scrollReg[1] && ny >= this.scrollReg[1])
        ny = this.scrollReg[1] - 1;
      if (this.curPos[1] >= this.scrollReg[0] && ny < this.scrollReg[0])
        ny = this.scrollReg[0];
      this.placeCursor(nx, ny);
    },

    /* Resolve the given position WRT the current cursor position
     * If pos or any part of it is missing, the cursor position (or the
     * corresponding part of it) is reported.
     * The position is ensured to be within the terminal's bounds.
     */
    _resolvePosition: function(pos) {
      if (! pos) pos = [this.curPos[0], this.curPos[1]];
      if (pos[0] == null) pos[0] = this.curPos[0];
      if (pos[1] == null) pos[1] = this.curPos[1];
      if (pos[0] > this.size[0]) pos[0] = this.size[0];
      if (pos[1] >= this.size[1]) pos[1] = this.size[1] - 1;
      if (pos[0] < 0) pos[0] = 0;
      if (pos[1] < 0) pos[1] = 0;
      return pos;
    },

    /* Resolve the given Y coordinate WRT the current cursor position
     */
    _resolveY: function(y) {
      /* Resolve missing values */
      if (Array.isArray(y)) y = y[1];
      if (y == null) y = this.curPos[1];
      /* Constrain to bounds */
      if (y >= this.size[1]) y = this.size[1] - 1;
      if (y < 0) y = 0;
      /* Done */
      return y;
    },

    /* Return a closure which assigns the attributes as configured by base
     * to any cell it's called on
     * If base is null, the terminal's current attributes are used.
     * If base is a DOM node, its data-attrs attribute is applied.
     * If base is a string, it itself is applied.
     * If amend is true, missing (i.e. === undefined) attribute values are
     * amended from this.curFg, this.curBg, this.curAttrs, this.modes,
     * respectively.
     */
    _prepareAttrs: function(base, amend) {
      /* Resolve attributes */
      var attrs = "", styleFG = "", styleBG = "";
      var region = null, modes = null;
      if (base == null || typeof base != "object" && typeof base != "string")
        base = {attrs: this.curAttrs, fg: this.curFg, bg: this.curBg,
                modes: cloneObject(this.modes)};
      /* Convert DOM node to string */
      if (typeof base == "object" && base.nodeType !== undefined) {
        base = base.getAttribute("data-attrs") || "";
      }
      /* Parse string */
      if (typeof base == "string") {
        var src = base;
        base = {fg: null, bg: null, attrs: 0};
        src.split(" ").forEach(function(el) {
          if (! el) return;
          if (/^fg-/.test(el)) base.fg = el.substring(3);
          if (/^bg-/.test(el)) base.bg = el.substring(3);
          var n = Terminal.ATTR[el.toUpperCase()];
          if (n != null) base.attrs |= n;
        });
        if (/^r?default$/.test(base.fg)) base.fg = null;
        if (/^r?default$/.test(base.bg)) base.bg = null;
        /* Undo reverse video */
        if ((!! (base.attrs & Terminal.ATTR.REVERSE)) ^
            (!! /\brevVideo\b/.test(src))) {
          base = {fg: base.bg, bg: base.fg, attrs: base.attrs};
        }
      }
      /* Possibly amend */
      if (amend) {
        if (base.fg === undefined) base.fg = this.curFg;
        if (base.bg === undefined) base.bg = this.curBg;
        if (base.attrs === undefined) base.attrs = this.curAttrs;
        if (base.modes === undefined) base.modes = cloneObject(this.modes);
      }
      /* Scan attributes */
      for (var i = 1; i <= Terminal.ATTR._MAX; i <<= 1) {
        if (base.attrs & i) attrs += " " + Terminal.ATTRNAME[i];
      }
      var blinking = (base.attrs & Terminal.ATTR.BLINK);
      /* Merge modes */
      if (base.modes) {
        modes = cloneObject(base.modes);
        for (var k in this.modes) {
          if (! this.modes.hasOwnProperty(k) || modes.hasOwnProperty(k))
            continue;
          modes[k] = this.modes[k];
        }
      } else {
        modes = cloneObject(this.modes);
      }
      /* Special-case reverse video */
      var reversed = false;
      if ((!! (base.attrs & Terminal.ATTR.REVERSE)) ^
          (!! modes.reverseVideo)) {
        reversed = true;
        base = {fg: base.bg, bg: base.fg, attrs: base.attrs,
                region: base.region, modes: base.modes};
      }
      /* Foreground and background */
      if (base.fg != null) {
        attrs += " fg-" + base.fg;
        styleFG = parseRGB(base.fg);
      } else {
        attrs += (reversed) ? " fg-rdefault" : " fg-default";
      }
      if (base.bg != null) {
        attrs += " bg-" + base.bg;
        styleBG = parseRGB(base.bg);
      } else {
        attrs += (reversed) ? " bg-rdefault" : " bg-default";
      }
      /* Strip leading space */
      attrs = attrs.replace(/^ /, "");
      /* Appply scrolling region / modes */
      if (base.region) region = base.region;
      /* Account for reverse video */
      if (modes.reverseVideo) attrs += " revVideo";
      /* Resolve scrolling region */
      if (! region && this.scrollReg)
        region = [this.scrollReg[0], this.scrollReg[1]];
      /* Result */
      var ret = function(node) {
        node.setAttribute("data-attrs", attrs);
        node.style.color = styleFG;
        node.style.background = styleBG;
        if (blinking)
          node.style.animationDelay = "-" + (Date.now() % 1000) + "ms";
      };
      /* Amend further attributes */
      ret.region = region;
      ret.modes = modes;
      if (amend) {
        base.region = region;
        base.modes = modes;
      }
      return ret;
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
      var attrs = this._prepareAttrs(pos, true);
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
            if (attrs.modes.autowrap) {
              pos[0] = 0;
              pos[1]++;
              /* Respect scrolling regions */
              if (attrs.region) {
                if (attrs.region[0] != attrs.region[1] &&
                    pos[1] == attrs.region[1]) {
                  pos[1]--;
                  this.scroll(1, attrs.region);
                } else if (pos[1] == this.size[1]) {
                  pos[1]--;
                }
              }
              cl = this.growLines(pos[1]);
              if (pos[1] == this.size[1]) pos[1]--;
              /* Select first cell */
              cc = this.growCells(cl, 0);
            } else {
              /* No auto-wrapping... */
              pos[0]--;
              cl = this.growLines(pos[1]);
              cc = this.growCells(cl, pos[0]);
            }
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
     * Unless noDiscard is true, characters that would be outside the visible
     * area of the terminal are discarded.
     * Unless noMove is true, the cursor is moved to the right by the length
     * of the text, up to the right border of the visible area (even if
     * noDiscard is true); line wrapping may occur.
     * If text is a number, the amount of spaces as indicated by it is
     * inserted.
     */
    insertTextRaw: function(text, pos, noMove, noDiscard) {
      this.checkMounted();
      /* Resolve position */
      pos = this._resolvePosition(pos);
      var attrs = this._prepareAttrs(pos, true);
      /* Acquire various variables */
      var line = this.growLines(pos[1]);
      var children = line.children;
      var cell = this.growCells(line, pos[0], true);
      var isNumber = (typeof text == "number");
      /* Calculate output length */
      var tlm1 = (isNumber) ? text - 1 : text.length - 1;
      if (noMove && ! noDiscard)
        tlm1 = Math.min(tlm1, this.size[0] - pos[0] - 1);
      for (var i = 0; i <= tlm1; i++) {
        var ch = (isNumber) ? " " : text[i];
        /* Decode surrogate pairs */
        if (/[\uD800-\uDBFF]/.test(ch) && i < tlm1 &&
            /[\uDC00-\uDFFF]/.test(text[i + 1]))
          ch += text[++i];
        /* Wrap line if necessary */
        if (! noMove && pos[0] >= this.size[0]) {
          if (attrs.modes.autowrap) {
            if (! noDiscard)
              this.eraseLine(false, true, [this.size[0], pos[1]]);
            pos[0] = 0;
            pos[1]++;
            /* Scroll if necessary */
            if (attrs.region) {
              if (attrs.region[0] != attrs.region[1] &&
                  pos[1] == attrs.region[1]) {
                pos[1]--;
                this.scroll(1, attrs.region);
              } else if (pos[1] == this.size[1]) {
                pos[1]--;
              }
            } else if (pos[1] == this.size[1]) {
              pos[1]--;
            }
            line = this.growLines(pos[1]);
            cell = this.growCells(line, 0);
          } else {
            /* No auto-wrapping... */
            pos[0]--;
            cell = this.growCells(line, pos[0]);
          }
        }
        /* Insert character */
        var nc = makeNode("span", "cell");
        attrs(nc);
        nc.textContent = ch;
        line.insertBefore(nc, cell);
        /* Advance position */
        pos[0]++;
      }
      /* Truncate line if necessary */
      if (! noDiscard) {
        this.eraseLine(false, true, [this.size[0], pos[1]]);
      }
      /* Ensure the cursor has not moved away */
      if (noMove) {
        this._placeCursor();
      } else {
        if (pos[0] >= this.size[0]) pos[0] = this.size[0] - 1;
        this._placeCursor(pos[0], pos[1]);
      }
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
      this.insertTextRaw(insert, pos, true, noDiscard);
    },

    /* Raw line manipulation
     * Adds or removes the given amounts of lines at the given position; the
     * lines added are returned as an array (for further processing).
     * It is the caller's duty to maintain consistency.
     */
    _spliceLines: function(y, remove, insert) {
      var content = this._contentNode();
      var lines = content.children;
      /* Remove lines */
      for (var i = 0; i < remove; i++) {
        var line = lines[this._offscreenLines + y];
        if (! line) break;
        content.removeChild(line);
      }
      /* Insert lines */
      var ln = this.getLine(y), added = [];
      if (ln) {
        for (var i = 0; i < insert; i++) {
          var node = makeNode("div");
          added.push(node);
          content.insertBefore(node, ln);
        }
      } else {
        var ip = this._offscreenLines + y, rl = ip + insert;
        while (lines.length < rl) {
          var node = makeNode("div");
          if (lines.length >= ip) added.push(node);
          content.appendChild(node);
        }
      }
      /* Done */
      return added;
    },

    /* Remove and insert some amount of lines after the given position */
    spliceLines: function(y, remove, insert) {
      this.checkMounted();
      /* Resolve coordinate */
      y = this._resolveY(y);
      var attrs = this._prepareAttrs(y, true);
      /* Perform action */
      if (attrs.region) {
        /* Insertion and deletion only work within scrolling regions (although
         * it is different across different console emulators). */
        if (y >= attrs.region[0] || y < attrs.region[1]) {
          /* Line manipulation becomes scrolling */
          this.scroll(remove, [y, attrs.region[1]], true);
          this.scroll(-insert, [y, attrs.region[1]], true);
        }
      } else {
        /* Perform actual splicing; apply attributes */
        this._spliceLines(y, remove, insert).forEach(attrs);
        /* Retain scrolling position */
        this._updatePadding();
      }
    },

    /* Erase part of the line as indicated by pos or the cursor position */
    eraseLine: function(before, after, pos) {
      /* Resolve position */
      pos = this._resolvePosition(pos);
      var attrs = this._prepareAttrs(pos, true);
      /* Determine line and bounds */
      var line = this.getLine(pos[1]);
      if (! line) return;
      var from = pos[0], to = pos[0] + 1;
      if (before) from = null;
      if (after) to = null;
      /* Actually erase */
      var range = this._cellRange(line, from, to);
      if (! before && ! after) {
        /* NOP */
      } else if (after) {
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
      var attrs = this._prepareAttrs(pos, true);
      /* Obtain reference to line array */
      var content = this._contentNode();
      var lines = content.children;
      /* Clear line */
      this.eraseLine(before, after, pos);
      /* Clear lines above or below */
      if (before) {
        for (var y = 0; y < pos[1]; y++) {
          var ln = lines[this._offscreenLines + y];
          this._clearLine(ln);
          attrs(ln);
        }
      }
      if (after) {
        var fl = this._offscreenLines + pos[1] + 1;
        while (lines.length > fl) {
          var ln = content.lastElementChild;
          content.removeChild(ln);
        }
        attrs(content);
      }
      /* Clear scrollback */
      if (scrollback) {
        var fl = lines.length - this._offscreenLines;
        while (lines.length > fl) {
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
        var couldScroll = (this.scrollReg &&
                           this.scrollReg[0] != this.scrollReg[1]);
        if (reverse) {
          /* Reverse line feed. Waaah! */
          if (couldScroll) {
            if (this.curPos[1] == this.scrollReg[0]) {
              /* Scroll down */
              this.scroll(-1);
            } else if (this.curPos[1] > 0) {
              /* Only move cursor */
              this.curPos[1]--;
            }
          } else if (this.curPos[1] > 0) {
            /* Move cursor */
            this.curPos[1]--;
          } else {
            /* Insert fresh line */
            this.spliceLines(null, 0, 1);
          }
        } else {
          /* "Forward" line feed */
          if (couldScroll) {
            if (this.curPos[1] == this.scrollReg[1] - 1) {
              /* Scroll up */
              this.scroll(1);
            } else if (this.curPos[1] < this.size[1] - 1) {
              /* Only move cursor */
              this.curPos[1]++;
            }
          } else {
            /* Move cursor */
            this.curPos[1]++;
            /* Scrolling will happen implicitly when _updatePadding() is
             * called (if necessary). */
          }
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
      if (! noPersist) this.savedAttrs = ret;
      /* Done */
      return ret;
    },

    /* Restore the attributes as saved before by saveAttributes() */
    restoreAttributes: function() {
      if (this.savedAttrs) this.savedAttrs();
    },

    /* Return an array of the current tab stops */
    getTabStops: function() {
      var f = this.tabStops.hasOwnProperty.bind(this.tabStops);
      return Object.keys(this.tabStops).filter(f);
    },

    /* Add or remove tab stops as specified
     * del is an array of tab stop indices to remove, add is one of such to
     * add.
     */
    editTabStops: function(del, add) {
      this.checkMounted();
      if (typeof del == "number") del = [del];
      if (typeof add == "number") add = [add];
      if (del) {
        del.forEach(function(el) { delete this.tabStops[el]; }.bind(this));
      }
      if (add) {
        add.forEach(function(el) {
          if (this.size && el >= this.size[0]) return;
          this.tabStops[el] = true;
        }.bind(this));
      }
    },

    /* Move the cursor to the next horizontal tab stop */
    _tabulate: function() {
      do {
        this.curPos[0]++;
      } while (this.curPos[0] < this.size[0] &&
               ! this.tabStops[this.curPos[0]]);
      if (this.curPos[0] > this.size[0]) this.curPos[0] = this.size[0];
    },

    /* Move the cursor by to the next horizontal tab stop n times */
    tabulate: function(n) {
      if (n == null) n = 1;
      for (var i = 0; i < n; i++) this._tabulate();
      this._placeCursor();
    },

    /* Set the scrolling region
     * If top and bottom are null, the scrolling region is removed;
     * otherwise, a null value is replaced by the current top/bottom row
     * index, respectively.
     */
    setScrollRegion: function(top, bottom) {
      this.checkMounted();
      if (top == null && bottom == null) {
        this.scrollReg = null;
      } else {
        if (top == null) top = 0;
        if (bottom == null) bottom = this.size[1];
        this.scrollReg = [top, bottom];
      }
    },

    /* Scroll the given region by n lines
     * Positive n scroll up, negative scroll down.
     * If the region is not given or either part of it is null, values from
     * the terminal's current scrolling region are amended.
     * Attributes for the new lines are derived from region.
     * If noScrollback is true, the scrollback buffer is never modified.
     */
    scroll: function(n, region, noScrollback) {
      /* Extract display attributes */
      var attrs = this._prepareAttrs(region, true);
      /* Resolve region */
      var oreg = attrs.region;
      if (oreg == null) oreg = [0, this.size[1]];
      if (region == null) region = oreg;
      if (region[0] == null) region[0] = oreg[0];
      if (region[1] == null) region[1] = oreg[1];
      /* Abort early if nothing to do */
      if (! n) return;
      /* Determine if the scrollback buffer will be used */
      var scrollback = (region[0] == 0 && ! noScrollback);
      /* Actual line manipulation */
      var added;
      if (n > 0) {
        /* Cap to scrolling region length */
        if (n > region[1] - region[0]) n = region[1] - region[0];
        /* Remove lines above, or update _offscreenLines */
        if (scrollback) {
          this._offscreenLines += n;
        } else {
          this._spliceLines(region[0], n, 0);
        }
        /* Add lines below */
        added = this._spliceLines(region[1] - n, 0, n);
      } else {
        /* Make n positive; cap to scrolling region length */
        n = -n;
        if (n > region[1] - region[0]) n = region[1] - region[0];
        /* Remove lines below */
        this._spliceLines(region[1] - n, n, 0);
        /* Add lines above */
        added = this._spliceLines(region[0], 0, n);
      }
      /* Apply attributes to newly inserted lines */
      added.forEach(attrs);
      /* Maintain consistency */
      this._placeCursor();
    },

    /* Invoke the terminal's bell or try to attract user attention otherwise
     * If no acoustical bell is present or the visualBell option is true, the
     * visual bell is invoked.
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
    },

    /* Enable or disable a mode as given by a code (or the name) depending on
     * value
     * A true value enabled the mode, a false one disables it. */
    setMode: function(code, value) {
      if (/^\?(47|1047|1049)$/.test(code)) {
        this.selectScreen((value) ? 1 : 0);
        return;
      } else if (/^\?(9|100[02356])$/.test(code)) {
        switch (code) {
          case "?9": this.mouseTrack = (value) ? 1 : 0; break;
          case "?1000": this.mouseTrack = (value) ? 2 : 0; break;
          case "?1002": this.mouseTrack = (value) ? 3 : 0; break;
          case "?1003": this.mouseTrack = (value) ? 4 : 0; break;
          case "?1005": this.mouseEncode = (value) ? 1 : 0; break;
          case "?1006": this.mouseEncode = (value) ? 2 : 0; break;
        }
        this._lastMouse = null;
        return;
      }
      var name = Terminal.MODE_CODES[code] || code;
      this.modes[name] = value;
      if (name == "origin" || name == "cursorVisible") {
        this.placeCursor();
      } else if (name == "reverseVideo") {
        this.reverseVideo();
      }
    },

    /* Reverse video (or un-reverse it) globally
     * Sections with the reverse video attribute set become "normal".
     */
    reverseVideo: function(value) {
      /* Helper */
      reverse = function(node) {
        var attrs = node.getAttribute("data-attrs") || "";
        var func = attrCache[attrs];
        if (! func) {
          func = this._prepareAttrs(attrs);
          attrCache[attrs] = func;
        }
        func(node);
      }.bind(this);
      var attrCache = {};
      /* Update instance state */
      if (value == undefined) {
        value = this.modes.reverseVideo;
      } else {
        this.modes.reverseVideo = value;
      }
      /* We can do while not mounted, but that should not be relied
       * upon */
      if (! this.node) return;
      /* Check if node is already reversed; apply attribute */
      var cntNode = this._contentNode();
      var attrs = cntNode.getAttribute("data-attrs") || "";
      var isReversed = /\brevVideo\b/.test(attrs);
      /* Check whether to reverse */
      if ((!! value) != (!! isReversed)) {
        /* Reverse! */
        reverse(cntNode);
        var nodes = cntNode.querySelectorAll("*");
        Array.prototype.forEach.call(nodes, reverse);
      }
    },

    /* Install a handler for a CSI sequence
     * func is the effective function string (as explained under handleCSI);
     * callback is a function to call when the CSI function is reached. When
     * the control function subscribed to is invoked, the callback is called
     * with the this variable pointing to the terminal emulator instance and
     * the parameter object as elaborated under handleCSI as the only
     * argument.
     */
    addCSI: function(func, callback) {
      this.csiHandlers[func] = callback;
      return callback;
    },

    /* Handle a CSI sequence
     * The parameter object is expected to have two members:
     * params: The parameter string (consisting of the parameter bytes).
     * func  : The function string (consisting of the intermediate bytes and
     *         the final byte).
     * Additional members are amended:
     * paramsPrivate: Whether the parameter string starts with a character
     *                indicating a private-mode sequence.
     * funcPrivate  : Whether the final byte is in the private use range
     *                (independently from paramsPrivate).
     * isPrivate    : paramsPrivate || funcPrivate
     * paramArray   : The parsed-out parameter string, as obtainable via
     *                Terminal.parseParamString(). Only present if the
     *                parameter string is not private.
     * effFunc      : The first character of the parameter string if it is
     *                private (or none otherwise), followed by the
     *                intermediate bytes and the final byte. The effective
     *                index into the handler table.
     * NOTE that the escape sequence parser may inject additional attributes
     *      not listed here.
     * Returns false if a handler was not found or its return value is
     * identical (===) to false or true otherwise to aid monkey-patching.
     */
    handleCSI: function(params) {
      params.paramsPrivate = /^[<-?]/.test(params.params);
      params.funcPrivate = /[p-~]$/.test(params.func);
      params.isPrivate = params.paramsPrivate || params.funcPrivate;
      if (! params.paramsPrivate)
        params.paramArray = Terminal.parseParamString(params.params);
      params.effFunc = ((params.paramsPrivate) ? params.params[0] : "") +
                        params.func;
      var handler = this.csiHandlers[params.effFunc];
      if (! handler) return false;
      if (handler.call(this, params) === false) return false;
      return true;
    },

    /* Handle a control string
     * string holds the control (or character) string, excluding the final
     * string terminator, but including the (single-character) control code
     * that initiated the string.
     */
    handleCSTR: function(string) {
      /* None implemented. */
    },

    /* Handle single-character C0 and C1 controls */
    _handleCC: function(ch) {
      if (/[\x07\b\t\v\x7f]/.test(ch) &&
          ! this.modes.displayControls) {
        switch (ch) {
          case "\x07": this.beep(); break;
          case "\b": this.moveCursor(-1, 0); break;
          case "\t": this.tabulate(); break;
          case "\v": this.newLine(false, true); break;
        }
      } else {
        switch (ch) {
          case "\0":
            /* NOP */
            break;
          case "\n": case "\f": case "\x84":
            this.newLine(false, true);
            break;
          case "\r":
            this.newLine(true, false);
            break;
          case "\x85":
            this.newLine(true, true);
            break;
          case "\x88":
            this.editTabStops(null, this.curPos[0]);
            break;
          case "\x8d":
            this.newLine(false, true, true);
            break;
          default:
            this._handleText(ch);
        }
      }
    },

    /* Process a SGR (Select Graphic Rendition) escape sequence
     * Outlined into a separate method because of the potentially complex
     * syntax.
     */
    _handleSGR: function(params) {
      var seqLen = 0, seqBuf = null;
      params.forEach(function(el) {
        /* Aggregate split multi-part entries */
        if (seqBuf != null) {
          seqBuf.push(el);
          if (seqBuf.length < seqLen) return;
          el = seqBuf.join(":");
        }
        /* Handle single entries */
        if (el == null) el = 0;
        switch (el) {
          case  0: this.setAttributes(null, null, 0); break;
          case  1: this.curAttrs |= Terminal.ATTR.BOLD; break;
          case  2: this.curAttrs |= Terminal.ATTR.DIM; break;
          case  3: this.curAttrs |= Terminal.ATTR.ITALIC; break;
          case  4: this.curAttrs |= Terminal.ATTR.UNDERLINE; break;
          case  5: this.curAttrs |= Terminal.ATTR.BLINK; break;
          case  6: this.curAttrs |= Terminal.ATTR.FASTBLINK; break;
          case  7: this.curAttrs |= Terminal.ATTR.REVERSE; break;
          case  8: this.curAttrs |= Terminal.ATTR.HIDDEN; break;
          case  9: this.curAttrs |= Terminal.ATTR.STRIKE; break;
          case 21: this.curAttrs |= Terminal.ATTR.DBLUNDERLINE; break;
          case 22:
            this.curAttrs &= ~(Terminal.ATTR.BOLD | Terminal.ATTR.DIM);
            break;
          case 23: this.curAttrs &= ~Terminal.ATTR.ITALIC; break;
          case 24:
            this.curAttrs &= ~(Terminal.ATTR.UNDERLINE |
                               Terminal.ATTR.DBLUNDERLINE);
            break;
          case 25:
            this.curAttrs &= ~(Terminal.ATTR.BLINK |
                               Terminal.ATTR.FASTBLINK);
            break;
          case 27: this.curAttrs &= ~Terminal.ATTR.REVERSE; break;
          case 28: this.curAttrs &= ~Terminal.ATTR.HIDDEN; break;
          case 29: this.curAttrs &= ~Terminal.ATTR.STRIKE; break;
          case 30: case 31: case 32: case 33:
          case 34: case 35: case 36: case 37:
            this.curFg = el - 30;
            break;
          case 38:
            seqLen = 2;
            seqBuf = [38];
            return;
          case 39:
            this.curFg = null;
            break;
          case 40: case 41: case 42: case 43:
          case 44: case 45: case 46: case 47:
            this.curBg = el - 40;
            break;
          case 48:
            seqLen = 2;
            seqBuf = [48];
            return;
          case 49:
            this.curBg = null;
            break;
          case 90: case 91: case 92: case 93:
          case 94: case 95: case 96: case 97:
            this.curFg = el - 82;
            break;
          case 100: case 101: case 102: case 103:
          case 104: case 105: case 106: case 107:
            this.curBg = el - 92;
            break;
        }
        /* Possibly accumulate more entries */
        if (el == "38:2" || el == "48:2") {
          seqLen = 5;
          return;
        } else if (el == "38:5" || el == "48:5") {
          seqLen = 3;
          return;
        }
        /* Apply! */
        if (/^38:2:/.test(el)) {
          this.curFg = "rgb-" + el.substring(5).replace(/:/g, "-");
        } else if (/^48:2:/.test(el)) {
          this.curBg = "rgb-" + el.substring(5).replace(/:/g, "-");
        } else if (/^38:5:/.test(el)) {
          this.curFg = el.substring(5);
        } else if (/^48:5:/.test(el)) {
          this.curBg = el.substring(5);
        }
        /* Reset */
        seqLen = 0;
        seqBuf = null;
      }.bind(this));
    },

    /* Process Device Status Report escape sequence */
    _handleDSR: function(param) {
      if (param == "5") {
        /* Actual Device Status Report; replying with "OK" */
        this._queueInput("\x1b[0n");
      } else if (param == "6") {
        /* Cursor Position Report */
        this._queueInput("\x1b[" + (this.curPos[1] + 1) + ";" +
                         (this.curPos[0] + 1) + "R");
      } else if (param == "?6") {
        /* Cursor Position Report with private-mode modifier */
        this._queueInput("\x1b[?" + (this.curPos[1] + 1) + ";" +
                         (this.curPos[0] + 1) + "R");
      }
    },

    /* Handle "bare" text WRT the current modes */
    _handleText: function(data) {
      if (this.modes.insert) {
        this.insertTextRaw(data);
      } else {
        this.writeTextRaw(data);
      }
    },

    /* Feed the given amount of Unicode codepoints to display or processing
     * This is what you want to use for displaying already-decoded text. */
    write: function(text) {
      this._writeStr(this._decoder.flush() + text);
    },

    /* Feed the given amount of binary data to display or processing
     * Here goes the input stream you receive from the client. */
    writeBin: function(data) {
      this._writeStr(this._decoder.decode(data));
    },

    /* Process the given text and schedule display as necessary */
    _writeStr: function(text) {
      this.parser.process(text);
      /* Schedule DOM updates */
      if (this._pendingUpdate[0] == null) {
        this._pendingUpdate[0] = requestAnimationFrame(function() {
          this._pendingUpdate[0] = null;
          this.flush();
        }.bind(this));
      }
      if (this._pendingUpdate[1] == null) {
        this._pendingUpdate[1] = setInterval(this.flush.bind(this), 1000);
      }
    },

    /* Actually render the state changes queued by write() and writeBin() */
    flush: function() {
      /* Possibly clear pending updates */
      if (this._pendingUpdate[0] != null) {
        cancelAnimationFrame(this._pendingUpdate[0]);
        this._pendingUpdate[0] = null;
      }
      if (this._pendingUpdate[1] != null && this._accum.isEmpty()) {
        clearInterval(this._pendingUpdate[1]);
        this._pendingUpdate[1] = null;
      }
      /* Actually write text */
      this._accum.run(this._handleText, this);
    },

    /* Queue some data as input to be read */
    _queueInput: function(data) {
      /* Convert strings to bytes */
      if (typeof data == "string") {
        if (! data) return;
        /* HACK: Maybe use the TextEncoder API instead? */
        var edata = unescape(encodeURI(data));
        data = new Uint8Array(edata.length);
        for (var i = 0; i < edata.length; i++)
          data[i] = edata.charCodeAt(i);
      }
      /* Check whether an event should be fired */
      var fire = (! this._queuedInput.length);
      /* Queue data */
      this._queuedInput.push(data);
      /* Dispatch event */
      if (fire && this.oninput) {
        var evt = new Event("input");
        evt.target = this;
        this.oninput(evt);
      }
    },

    /* Extract any queued input and return a coalesced ArrayBuffer */
    read: function() {
      /* Special-case empty read */
      if (! this._queuedInput.length) return new ArrayBuffer(0);
      /* Pop queue */
      var queued = this._queuedInput;
      this._queuedInput = [];
      /* Coalesce data */
      var len = 0;
      queued.forEach(function(el) { len += el.length; });
      var ret = new ArrayBuffer(len);
      var view = new Uint8Array(ret);
      var idx = 0;
      queued.forEach(function(el) {
        view.set(el, idx);
        idx += el.length;
      });
      /* Return result */
      return ret;
    }
  };

  /* Return export */
  return Terminal;
}();
