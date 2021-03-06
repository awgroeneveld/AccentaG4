(function () {
 
  var Timer = (callback, timeout) => {
    var timer;
    function start () {
      if (!timer) {
        timer = setTimeout(callback, timeout);
      }
    }
    function stop () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
    function restart () {
      stop();
      start();
    }
    return {
      start: start,
      stop: stop,
      restart: restart
    };
  };

  var Lcd = (callback) => {
    // https://dawes.wordpress.com/2010/01/05/hd44780-instruction-set/
    var display;
    var pos;
    var cmd = false;
    var cursor = false;
    var timer;
    function show () {
      callback(display);
    }
    function write (char) {
      if (char >= ' ') {
        var row, col;
        if (pos < 16) {
          row = 0;
          col = pos;
        } else {
          row = 1;
          col = pos - 64;
        }
        var previousChar = display[row].substr(col, 1);
        display[row] = display[row].substr(0, col) + char + display[row].substr(col + 1);
        return previousChar;
      }
    }
    function advance () {
      pos++;
    }
    function start () {
      var cursorChar = '_';
      if (cursor) {
        timer = setInterval(function () {
          cursorChar = write(cursorChar);
          show();
        }, 400);
      }
    }
    function stop () {
      if (timer) {
        clearInterval(timer);
      }
    }
    function refresh () {
      stop();
      show();
      start();
    }
    function offline () {
      display = ['Connecting...   ', '                '];
      show();
    }
    function reset () {
      display = ['                ', '                '];
      pos = 0;
      refresh();
    }
    function ingest (data) {
      for (var i = 0; i < data.length; i++) {
        var char = data.charCodeAt(i);
        if (cmd) {
          if (char >= 0x80) { // set position
            pos = char - 0x80;
          } else {
            console.log('unknown command: ', char.toString(16));
          }
          cmd = false;
        } else {
          switch (char) {
            // case 0x03: // unknown
            //   break;
            case 0x04: // command
              cmd = true; break;
            case 0x05: // hide cursor
              cursor = false; break;
            case 0x06: // show cursor
              cursor = true; break;
            case 0x07: // cursor right
              pos++; break;
            case 0x0a: // newline
              pos = 64; break;
            case 0x0c: // clear
              reset(); break;
            // case 0x0d: // unknown
            //   break;
            // case 0x10: // unknown
            //   break;
            // case 0x16: // unknown
            //   break;
            default:
              if (char >= 0x20 && char <= 0x7f) {
                write(data.charAt(i));
                advance();
              } else {
                console.log('unprintable character: ', char.toString(16));
              }
          }
        }
      }
      refresh();
    }
    reset();
    return {
      offline: offline,
      ingest: ingest,
      reset: reset
    }
  };

  var Connection = (url, handlers) => {
    offline()
    var ws;
    var autoRetry = Timer(() => {
      console.log('connection timeout');
      ws.close();
      start();
    }, 3000);
    var keepAlive = Timer(() => {
      console.log('connection lost');
      offline()
      start();
    }, 5000);
    function isConnected() {
      return ws && ws.readyState === WebSocket.OPEN;
    }
    function online() {
      handlers.onOnline && handlers.onOnline();
    }
    function offline() {
      handlers.onOffline && handlers.onOffline();
    }
    function message(data) {
      handlers.onMessage && handlers.onMessage(data);
    }
    function start() {
      if (isConnected()) {
        console.log('already connected');
      } else {
        console.log('establishing connection');
        ws = new WebSocket(url);
        autoRetry.start();
        ws.onopen = () => {
          console.log('connection established');
          autoRetry.stop();
          keepAlive.start();
          online();
          send('?'); // request current status
        };
        ws.onerror = (err) => {
          console.log('connection error', err);
          autoRetry.restart();
        };
        ws.onclose = () => {
          console.log('connection closed');
          offline()
        }
        ws.onmessage = (evt) => {
          keepAlive.restart();
          message(evt.data);
        };
      }
    }
    function stop() {
      if (isConnected()) {
        console.log('closing connection');
        keepAlive.stop();
        ws.close();
        offline()
      } else {
        console.log('already disconnected');
      }
    }
    function send(msg) {
      ws.send(msg);
    }
    return {
      start: start,
      stop: stop,
      send: send
    }
  };

  var Led = (attr, values) => {
    var length = values.length;
    return {
      ingest: (data) => {
        for (var i = 0; i < length; i++) {
          var led = values.charAt(i);
          $('[' + attr + '~="' + led + '"]').toggleClass('active', data.indexOf(led) !== -1);
        }
      },
      reset: () => {
        $('[' + attr + ']').removeClass('active');
      }
    };
  };

  $(() => {
    var lcd = Lcd((rows) => {
      $('#row0', '.lcd').html(rows[0]);
      $('#row1', '.lcd').html(rows[1]);
    });

    var keypadLed = Led('data-keypad', '12345678UTSP');
    var panelLed = Led('data-panel', 'SAIP');

    var url = location.protocol === 'https:' ? 
      'wss://' + location.hostname + ':8443' : 
      'ws://' + location.hostname + ':8080'

    var connection = Connection(url, {
      onMessage: (msg) => {
        if (msg) {
          $('.lcd').removeClass('lost');
          var type = msg.charAt(0);
          var data = msg.substring(2);
          switch (type) {
            case 'S': // panel signals
              $('body').toggleClass('active', /[IP]/.test(data));
              panelLed.ingest(data);
              break;
            case 'P': // keypad messages
              keypadLed.ingest(data);
              break;
            case 'L': // LCD messages
              lcd.ingest(data);
              break;
            case 'H': // heartbeat
              if (parseInt(data, 10) > 120) {
                $('.lcd').addClass('stale');
              } else {
                $('.lcd').removeClass('stale');
              }
            default:
              break;
          }
        } else {
          $('.lcd').addClass('lost');
        }
      },
      onOnline: () => {
        lcd.reset()
      },
      onOffline: () => {
        panelLed.reset();
        keypadLed.reset();
        lcd.offline();
      }
    });

    // bind click commands
    $('[data-click]').click((e) => {
      connection.send($(e.target).data('click'));
    });

    // bind dbl-click commands
    $('[data-dblclick]').dblclick((e) => {
      connection.send($(e.target).data('dblclick'));
    });

    // connect/disconnect based on page visibility
    $(document).on({
      show: connection.start,
      hide: connection.stop
    });

    connection.start();
  });

}());