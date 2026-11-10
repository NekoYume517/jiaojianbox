(() => {
  'use strict';
  // The desktop shell turns native drops into a `native-files` event, so the
  // browser drag events stay unused there and the page is filled from that path.
  const nativeDrop = () => Boolean(window.desktop?.nativeFileDrop);
  function host(input) {
    return input.closest('.share-drop,.file-picker');
  }
  function paint(input) {
    const box = host(input);
    if (!box) return;
    let note = box.querySelector('.picker-name');
    if (!note) {
      note = document.createElement('small');
      note.className = 'picker-name';
      box.append(note);
    }
    const files = [...input.files || []];
    note.textContent = files.length ? files.map(file => file.name).join('、') : '未选择文件';
    box.classList.toggle('has-files', files.length > 0);
  }
  function fill(input, files) {
    const list = [...files || []];
    if (!input || input.disabled || !list.length) return false;
    const transfer = new DataTransfer();
    for (const file of list) transfer.items.add(file);
    input.files = transfer.files;
    paint(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function dropInput(target) {
    if (!(target instanceof Element)) return null;
    const box = target.closest('.file-picker,.share-drop');
    if (!box) return null;
    const input = box.querySelector('input[type=file]');
    return input && !input.disabled ? input : null;
  }
  const isFileDrag = event => [...event.dataTransfer?.types || []].includes('Files');
  function clearDrag() {
    document.querySelectorAll('.file-picker.drag-target,.share-drop.drag-target').forEach(el => el.classList.remove('drag-target'));
  }
  function markTarget(input) {
    const box = host(input);
    document.querySelectorAll('.file-picker.drag-target,.share-drop.drag-target').forEach(el => { if (el !== box) el.classList.remove('drag-target'); });
    box?.classList.add('drag-target');
  }
  document.addEventListener('dragover', event => {
    if (nativeDrop() || !isFileDrag(event)) return;
    const input = dropInput(event.target);
    if (!input) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    markTarget(input);
  });
  document.addEventListener('dragleave', event => {
    if (nativeDrop() || !(event.target instanceof Element) || event.relatedTarget) return;
    if (event.target.closest('.file-picker,.share-drop')) clearDrag();
  });
  document.addEventListener('drop', event => {
    if (nativeDrop()) return;
    const input = dropInput(event.target);
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    clearDrag();
    fill(input, event.dataTransfer?.files);
  });
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('change', event => {
    if (event.target.matches('input[type=file]')) paint(event.target);
  });
  document.addEventListener('input', event => {
    if (event.target.matches('input[type=file]')) paint(event.target);
  });
  window.desktop?.on?.('native-files', payload => {
    const picker = payload?.picker || '';
    const files = payload?.files || [];
    if (!picker || !files.length) return;
    const box = document.querySelector('[data-native-picker="' + picker + '"]');
    const input = box?.querySelector('input[type=file]');
    if (!input) return;
    const transfer = new DataTransfer();
    for (const file of files) {
      try {
        const binary = atob(file.data || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], file.name || 'file', { type: file.type || 'application/octet-stream' }));
      } catch (error) { /* skip unreadable payload */ }
    }
    if (!transfer.files.length) return;
    input.files = transfer.files;
    paint(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  window.filePickers = { paint, fill };
})();
