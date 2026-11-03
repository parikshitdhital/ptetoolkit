/* Shared login helper for every tool page (one login for the whole site) */
(function () {
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var css = '#ptk-login{position:fixed;inset:0;background:rgba(15,23,42,.65);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px}' +
    '#ptk-login .card{background:#fff;border-radius:12px;padding:24px;width:100%;max-width:340px;font-family:system-ui,sans-serif}' +
    '#ptk-login h3{margin:0 0 12px}#ptk-login input{width:100%;padding:10px;margin-bottom:10px;border:1px solid #ccc;border-radius:6px;font-size:16px;box-sizing:border-box}' +
    '#ptk-login button{width:100%;background:#1e2a78;color:#fff;border:0;border-radius:6px;padding:11px;font-size:15px;cursor:pointer}' +
    '#ptk-login .m{color:#b91c1c;font-size:14px;min-height:18px;margin:8px 0 0}#ptk-login .h{color:#6b7280;font-size:13px;margin:10px 0 0}' +
    '#ptk-userbar{display:flex;justify-content:flex-end;gap:12px;font:13px system-ui,sans-serif;color:#374151;padding:6px 16px}' +
    '#ptk-userbar a{color:#1e2a78;cursor:pointer;text-decoration:underline}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var PTK = {
    token: function () { return store.get('ptk_token'); },
    // fetch with the login token attached; returns { ok, status, data }
    api: function (url, opts) {
      opts = opts || {};
      var h = Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (store.get('ptk_token') || '') }, opts.headers || {});
      return fetch(url, Object.assign({}, opts, { headers: h })).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
      });
    },
    me: function () {
      var t = store.get('ptk_token');
      if (!t) return Promise.resolve(null);
      return fetch('/api/login', { headers: { Authorization: 'Bearer ' + t } })
        .then(function (r) { if (!r.ok) { store.del('ptk_token'); return null; } return r.json(); })
        .catch(function () { return null; });
    },
    logout: function () { store.del('ptk_token'); store.del('ptk_name'); location.reload(); },
    bar: function (me) {
      var el = document.getElementById('ptk-userbar');
      if (!el) { el = document.createElement('div'); el.id = 'ptk-userbar'; var m = document.querySelector('main') || document.body; m.insertBefore(el, m.firstChild); }
      el.innerHTML = 'Signed in as <b>' + esc(me.name) + '</b> <a id="ptk-logout">Log out</a>';
      document.getElementById('ptk-logout').onclick = PTK.logout;
    },
    loginCard: function (onReady) {
      var o = document.createElement('div'); o.id = 'ptk-login';
      o.innerHTML = '<div class="card"><h3>Student Login</h3><input id="ptk-u" placeholder="Username" autocomplete="username" autocapitalize="off">' +
        '<input id="ptk-p" type="password" placeholder="Password" autocomplete="current-password"><button id="ptk-go">Login</button>' +
        '<p class="m" id="ptk-m"></p><p class="h">Your teacher gives you your username and password.</p></div>';
      document.body.appendChild(o);
      var go = function () {
        document.getElementById('ptk-m').textContent = '';
        fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('ptk-u').value, password: document.getElementById('ptk-p').value }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok) { document.getElementById('ptk-m').textContent = x.d.error || 'Login failed'; return; }
            store.set('ptk_token', x.d.token); store.set('ptk_name', x.d.name);
            o.remove(); PTK.bar(x.d); onReady(x.d);
          })
          .catch(function () { document.getElementById('ptk-m').textContent = 'Could not reach the server.'; });
      };
      document.getElementById('ptk-go').onclick = go;
      document.getElementById('ptk-p').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    },
    // Call this on a tool page: shows the login card if needed, then runs onReady(user)
    start: function (onReady) {
      PTK.me().then(function (me) { if (me) { PTK.bar(me); onReady(me); } else PTK.loginCard(onReady); });
    }
  };
  window.PTK = PTK; window.escHtml = window.escHtml || esc;
})();
