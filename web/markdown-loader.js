(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char])).replace(/\n/g, '<br>');
  let ready = false;
  let loading = null;
  const load = () => {
    if (ready) return Promise.resolve(window.jjbMarkdown);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/markdown.js';
      script.async = true;
      script.onload = () => {
        ready = true;
        window.jjbMarkdownReady = true;
        document.dispatchEvent(new CustomEvent('jjb:markdown-ready'));
        resolve(window.jjbMarkdown);
      };
      script.onerror = () => {
        loading = null;
        reject(new Error('Markdown 组件加载失败'));
      };
      document.head.append(script);
    });
    return loading;
  };
  window.jjbMarkdown = { render: escape, enhance() {} };
  window.loadJjbMarkdown = load;
  window.jjbMarkdownReady = false;
})();
