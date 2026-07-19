(function () {
  "use strict";

  function createRunner() {
    var state = { success: null, failure: null };
    var proxy = new Proxy({}, {
      get: function (_, property) {
        if (property === "withSuccessHandler") {
          return function (handler) {
            state.success = handler;
            return proxy;
          };
        }
        if (property === "withFailureHandler") {
          return function (handler) {
            state.failure = handler;
            return proxy;
          };
        }
        if (property === "then") return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch("/api/rpc/" + encodeURIComponent(String(property)), {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest"
            },
            body: JSON.stringify({ args: args })
          })
            .then(function (response) {
              return response.json().catch(function () {
                return { success: false, message: "Invalid response from server" };
              }).then(function (payload) {
                if (!response.ok || !payload.success) {
                  throw new Error(payload.message || ("Server error " + response.status));
                }
                return payload.result;
              });
            })
            .then(function (result) {
              if (typeof state.success === "function") state.success(result);
            })
            .catch(function (error) {
              if (typeof state.failure === "function") state.failure(error);
              else console.error(error);
            });
        };
      }
    });
    return proxy;
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, "run", {
    configurable: false,
    enumerable: true,
    get: createRunner
  });
})();
