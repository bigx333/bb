export const notificationTraceInjection = `
(function () {
  if (window.__bbNotificationTraceInstalled) return;
  window.__bbNotificationTraceInstalled = true;
  var requestId = 0;
  var pendingFrame = false;
  var lastSample = '';
  function threadId() {
    var match = location.pathname.match(/\\/threads\\/([^/]+)/);
    return match ? match[1] : null;
  }
  function emit(stage, fields) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({
      type: 'bb-notification-trace', stage: stage, at: Date.now(),
      monotonicMs: performance.now(), threadId: threadId(), visibility: document.visibilityState
    }, fields || {}))); } catch {}
  }
  emit('page-start');
  document.addEventListener('visibilitychange', function () { emit('visibility'); });
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    var match = url && url.match(/\\/api\\/v1\\/threads\\/([^/?]+)\\/timeline(?:\\?|$)/);
    if (!match) return originalFetch.apply(this, arguments);
    var id = ++requestId;
    emit('timeline-request', { requestId: id, threadId: match[1] });
    var response = originalFetch.apply(this, arguments);
    response.then(function (result) {
      var serverDate = Date.parse(result.headers.get('date') || '');
      emit('timeline-response', { requestId: id, threadId: match[1], status: result.status, serverDate: Number.isFinite(serverDate) ? serverDate : null });
      result.clone().json().then(function (body) {
        if (typeof body.maxSeq === 'number') emit('timeline-body', { requestId: id, threadId: match[1], maxSeq: body.maxSeq });
      }).catch(function () {});
    }, function () { emit('timeline-error', { requestId: id, threadId: match[1] }); }).catch(function () {});
    return response;
  };
  function sample() {
    if (pendingFrame || !threadId()) return;
    pendingFrame = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        pendingFrame = false;
        var rows = document.querySelectorAll('[data-timeline-row-id]');
        var length = 0;
        var fingerprint = threadId() + ':';
        for (var i = 0; i < rows.length; i++) {
          var text = rows[i].textContent || '';
          length += text.length;
          fingerprint += rows[i].getAttribute('data-timeline-row-id') + ':' + text + ';';
        }
        if (fingerprint === lastSample) return;
        lastSample = fingerprint;
        emit('timeline-dom-frame', { rowCount: rows.length, textLength: length });
      });
    });
  }
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, characterData: true });
  sample();
})();
true;
`;
