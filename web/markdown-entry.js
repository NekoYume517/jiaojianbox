import { Marked } from 'marked';
import footnotes from 'marked-footnote';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';

const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const math = display => ({
  name: display ? 'displayMath' : 'inlineMath', level: display ? 'block' : 'inline',
  start: src => src.search(display ? /\$\$|\\\[/ : /\$|\\\(/),
  tokenizer(src) {
    const match = (display ? /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/ : /^(?:\$([^$\n]+?)\$(?!\$)|\\\(([\s\S]+?)\\\))/).exec(src);
    if (match) return {type:this.name || (display?'displayMath':'inlineMath'),raw:match[0],text:match[1]||match[2]};
  },
  renderer(token) {return `<span data-md-math="${escape(token.text)}" data-display="${display}"></span>`;}
});
let serial = 0, mermaidPromise;
function render(source, scope='message') {
  const parser = new Marked({gfm:true,breaks:false,async:false});
  parser.use(footnotes({prefixId:`${scope}-footnote-`,description:'注释',backRefLabel:'返回引用 {0}'}));
  parser.use({extensions:[math(true),math(false)],renderer:{html({text}) {return DOMPurify.sanitize(text,{ALLOW_DATA_ATTR:false,FORBID_TAGS:['button','input','form','style','iframe'],FORBID_ATTR:['style','id','name']});},code({text,lang}) {
    const language=(lang||'').split(/\s/)[0];
    const highlighted=hljs.getLanguage(language)?hljs.highlight(text,{language,ignoreIllegals:true}).value:escape(text);
    return `<div class="md-code"><div class="md-code-heading"><span>${escape(language||'文本')}</span><button type="button" data-md-copy>复制</button></div><pre${language==='mermaid'?' data-mermaid-source':''}><code class="hljs language-${escape(language)}">${highlighted}</code></pre></div>`;
  }}});
  const clean=DOMPurify.sanitize(parser.parse(String(source||'')),{ADD_ATTR:['target','data-md-copy','data-mermaid-source'],FORBID_TAGS:['style','script','iframe','object','embed','form','button-script'],FORBID_ATTR:['style']});
  const template=document.createElement('template');template.innerHTML=clean;
  template.content.querySelectorAll('[data-md-math]').forEach(node=>{node.innerHTML=katex.renderToString(node.dataset.mdMath,{displayMode:node.dataset.display==='true',throwOnError:false,trust:false,strict:'ignore',output:'html',maxExpand:500});});
  template.content.querySelectorAll('a').forEach(a=>{if(!a.getAttribute('href')?.startsWith('#')){a.target='_blank';a.rel='noopener noreferrer';}});
  template.content.querySelectorAll('img').forEach(img=>{img.loading='lazy';img.referrerPolicy='no-referrer';});
  template.content.querySelectorAll('table').forEach(table=>{const wrap=document.createElement('div');wrap.className='md-table';table.replaceWith(wrap);wrap.append(table);});
  return template.innerHTML;
}
async function enhance(root) {
  // Diagrams are rendered only after a complete reply. The engine stays local.
  for(const code of root.querySelectorAll('pre[data-mermaid-source]:not([data-rendered])')) {
    code.dataset.rendered='pending';
    try {
      mermaidPromise ||= import('./mermaid.js');
      const {default:mermaid}=await mermaidPromise;
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,htmlLabels:false,flowchart:{htmlLabels:false},theme:document.documentElement.dataset.theme==='dark'?'dark':'neutral'});
      const {svg}=await mermaid.render(`jjb-diagram-${++serial}`,code.textContent);
      if(!code.isConnected)continue;
      const diagram=document.createElement('div');diagram.className='md-diagram';
      diagram.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},ADD_ATTR:['dominant-baseline']});
      code.after(diagram);code.dataset.rendered='done';
    }catch {code.dataset.rendered='invalid';}
  }
}
window.jjbMarkdown={render,enhance};
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-md-copy]');if(!button)return;
  const code=button.closest('.md-code')?.querySelector('pre');
  try {await navigator.clipboard.writeText(code?.textContent||'');button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent='复制';},1500);}catch{button.textContent='复制失败';}
});
