/* wecon -- Web Console emulator
 * https://github.com/CylonicRaider/wecon */

/* Hide implementation details in namespace */
this.Terminal = function() {
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
