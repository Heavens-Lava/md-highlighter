// File list filter for the `mdhl serve` index page.
(function () {
  const q = document.getElementById('q');
  const docs = [...document.querySelectorAll('.doc')];
  q.addEventListener('input', () => {
    const v = q.value.toLowerCase().trim();
    docs.forEach(d => { d.hidden = v && !d.dataset.q.includes(v); });
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const first = docs.find(d => !d.hidden); if (first) location.href = first.href; }
  });
})();
