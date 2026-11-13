import {build} from 'esbuild';
import fs from 'node:fs/promises';
await build({entryPoints:['web/markdown-entry.js'],outfile:'web/vendor/markdown.js',bundle:true,minify:true,format:'iife',target:'es2022',external:['./mermaid.js'],legalComments:'eof'});
await build({entryPoints:['node_modules/mermaid/dist/mermaid.esm.mjs'],outfile:'web/vendor/mermaid.js',bundle:true,minify:true,format:'esm',target:'es2022',legalComments:'eof'});
await fs.copyFile('node_modules/katex/dist/katex.min.css','web/vendor/katex.css');
await fs.cp('node_modules/katex/dist/fonts','web/vendor/fonts',{recursive:true});
for(const name of ['marked','marked-footnote','dompurify','highlight.js','katex','mermaid']) {
 for(const file of ['LICENSE','LICENSE.md','LICENSE.txt']) {try {await fs.copyFile(`node_modules/${name}/${file}`,`web/vendor/${name.replace('.','-')}.LICENSE`);break;}catch{}}
}
