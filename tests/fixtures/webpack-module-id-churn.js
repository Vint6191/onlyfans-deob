"use strict";

// Synthetic fixture: values below are intentionally fake and must never be
// treated as current OnlyFans rules.  Its only purpose is to prove that Stage 2
// extracts checksum semantics without executing webpack imports or depending on
// numeric module ids.
(self.webpackChunkof_vue = self.webpackChunkof_vue || []).push([
  [9999], {
    700001: function(module, exports, req) {
      var unrelatedA = req(111111),
          hashProvider = req(222222),
          authStore = req(333333),
          unrelatedB = req(444444);
      exports.A = input => {
        const state = {};
        state.time = +new Date();
        const uid = authStore.A.getters["auth/authUserId"] || null;
        const hash = hashProvider()(["0123456789abcdef0123456789abcdef", state.time, input.url || "", uid || 0].join("\n"));
        state.sign = ["12345", hash, function(x) {
          return Math.abs(
            x[1 % x.length].charCodeAt(0) +
            x[7 % x.length].charCodeAt(0) +
            x[3 % x.length].charCodeAt(0) +
            x[11 % x.length].charCodeAt(0) +
            x[2 % x.length].charCodeAt(0) +
            x[19 % x.length].charCodeAt(0) +
            x[5 % x.length].charCodeAt(0) +
            x[13 % x.length].charCodeAt(0) +
            321
          ).toString(16);
        }(hash), "deadbeef"].join(":");
        return state;
      };
    }
  }
]);
