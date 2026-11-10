(() => {
  'use strict';
  function paint(input) {
    const host = input.closest('.share-drop,.file-picker');
    if (!host) return;
    let note = host.querySelector('.picker-name');
    if (!note) {
      note = document.createElement('small');
      note.className = 'picker-name';
      host.append(note);
    }
    const files = [...input.files || []];
    note.textContent = files.length ? files.map(file => file.name).join('、') : '未选择文件';
  }
  document.addEventListener('change', event => {
    if (event.target.matches('input[type=file]')) paint(event.target);
  });
  document.addEventListener('input', event => {
    if (event.target.matches('input[type=file]')) paint(event.target);
  });
  window.filePickers = { paint };
})();
