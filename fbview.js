/* Shared feedback renderer: used by practice.html, history.html and teacher.html */
(function () {
  var css = '.fb .score{font-size:18px;margin-bottom:12px}.fb .score span{font-size:44px;font-weight:700;color:#1e2a78}' +
    '.fb table{border-collapse:collapse;width:100%;font-size:14px}.fb td{border-bottom:1px solid #e5e7eb;padding:8px;vertical-align:top}' +
    '.fb .para{border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:10px 0;background:#fff}.fb h4{margin:0 0 6px}' +
    '.fb .g{color:#15803d;font-weight:700;margin:8px 0 2px}.fb .o{color:#b45309;font-weight:700;margin:8px 0 2px}.fb .b{color:#1e2a78;font-weight:700;margin:8px 0 2px}' +
    '.fb ul{margin:0 0 0 18px;padding:0}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var li = function (a) { return (a && a.length) ? '<ul>' + a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p><i>-</i></p>'; };
  var NAMES = { content: 'Content', form: 'Form', dsc: 'Development, Structure & Coherence', grammar: 'Grammar', glr: 'General Linguistic Range', vocab: 'Vocabulary Range', spelling: 'Spelling' };
  window.escHtml = esc;

  window.renderFeedback = function (f) {
    var h = '<div class="score"><span>' + esc(f.overall) + '</span> / 90<br><small>Estimated score (not an official PTE result)</small></div>';
    h += '<p><b>Essay type:</b> ' + esc(f.essay_type) + '. ' + esc(f.type_comment) + '</p>';
    if (f.topic_phrase) h += '<p><b>Topic phrase:</b> you wrote "' + esc(f.topic_phrase.student_wrote) + '" (' + esc(f.topic_phrase.verdict) + '). Better: <i>' + esc(f.topic_phrase.better_version) + '</i></p>';
    h += '<h3>Scores by criteria</h3><table>';
    Object.keys(NAMES).forEach(function (k) { var c = (f.criteria || {})[k]; if (c) h += '<tr><td>' + NAMES[k] + '</td><td><b>' + c.score + '/' + c.max + '</b></td><td>' + esc(c.comment) + '</td></tr>'; });
    h += '</table><h3>Paragraph by paragraph</h3>';
    (f.paragraphs || []).forEach(function (p) {
      h += '<div class="para"><h4>' + esc(p.name) + ' <small>' + esc(p.score90) + ' / 90</small></h4><p class="g">What worked</p>' + li(p.worked) + '<p class="o">To improve</p>' + li(p.improve) + '<p class="b">Alternative sentences</p>' + li(p.alternatives) + '</div>';
    });
    h += '<h3>Summary</h3><p>' + esc(f.summary) + '</p><p><b>Fix these next time:</b></p>' + li(f.top_fixes);
    return '<div class="fb">' + h + '</div>';
  };
})();
