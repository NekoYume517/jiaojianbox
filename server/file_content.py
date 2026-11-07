"""只提取文本，不执行脚本、宏或文件里的外部链接。"""
from pathlib import Path
import io
import zipfile
from xml.etree import ElementTree as ET

TEXT_EXTENSIONS = {'.txt','.md','.csv','.json','.log','.py','.js','.ts','.html','.css','.sql','.yaml','.yml','.xml','.c','.cpp','.h','.tex'}

def read_text(path: Path, filename: str, limit=12000):
    ext=Path(filename).suffix.lower()
    try:
        if ext in TEXT_EXTENSIONS:
            data=path.open('rb').read(200000)
            for encoding in ('utf-8-sig','gb18030','utf-16'):
                try:return data.decode(encoding)[:limit], '正文文本'
                except UnicodeError:continue
            return '', '文本编码无法识别'
        if ext=='.pdf':
            from pypdf import PdfReader
            reader=PdfReader(str(path))
            if reader.is_encrypted:return '', 'PDF 已加密'
            parts=[];length=0
            for page in reader.pages[:12]:
                part=page.extract_text() or '';parts.append(part);length+=len(part)
                if length>=limit:break
            text='\n'.join(parts)[:limit]
            return text, 'PDF 正文' if text else 'PDF 未包含可读取文字'
        if ext in {'.docx','.pptx','.xlsx','.zip'}:
            with zipfile.ZipFile(path) as archive:
                parts=[];budget=2*1024**2
                for member in archive.infolist():
                    if ext=='.zip':
                        parts.append(member.filename)
                        if len(parts)>=200:break
                        continue
                    wanted=(ext=='.docx' and member.filename=='word/document.xml') or (ext=='.pptx' and member.filename.startswith('ppt/slides/slide') and member.filename.endswith('.xml')) or (ext=='.xlsx' and (member.filename=='xl/sharedStrings.xml' or member.filename.startswith('xl/worksheets/sheet')) and member.filename.endswith('.xml'))
                    if not wanted or member.file_size>budget:continue
                    budget-=member.file_size
                    node=ET.fromstring(archive.read(member))
                    parts.extend((n.text or '') for n in node.iter() if n.tag.split('}')[-1] in {'t','v'})
                    if sum(map(len,parts))>=limit:break
                return '\n'.join(parts)[:limit], '压缩包文件目录' if ext=='.zip' else 'Office 正文'
        return '', '当前格式暂按文件名判断'
    except Exception:
        return '', '正文暂无法读取，按文件名判断'
