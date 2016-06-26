/* wecon -- Web Console emulator
 * https://github.com/CylonicRaider/wecon */

/* Hide implementation details in namespace */
this.Terminal = function() {
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
      if (cp > 0x10FFFF) throw RangeError('Bad code point: ' + cp);
      cp -= 0x10000;
      return String.fromCharCode(cp >>> 10 | 0xD800, cp & 0x3FF | 0xDC00);
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
        } else {
          /* Proper sequence */
          var cl = 1, v = codes[i++];
          /* Determine length */
          while (cl < 6 && v >> (6 - cl) & 1) cl++;
          var sl = cl + 1, cp = v & (1 << (6 - cl)) - 1;
          /* Check for truncated sequences */
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
          /* Verify the sequence was not interrupted */
          if (cl) {
            sl -= cl;
            while (sl--) ret += this.replacement;
            continue;
          }
          ret += this._fromCodePoint(cp);
        }
      }
      /* Done */
      return ret;
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
   * scrollback: Maximum length of the scrollback buffer. When not set, all
   *             lines "above" the display area are immediately discarded;
   *             when set to positive infinity, arbitrarily many lines are
   *             stored.
   */
  function Terminal(options) {
    this.width = options.width;
    this.height = options.height;
    this.bell = options.bell;
    this.visualBell = options.visualBell;
    this.scrollback = options.scrollback;
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
  };

  /* Return export */
  return Terminal;
}();
