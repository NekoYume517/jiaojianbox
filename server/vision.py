"""Prepare an image for a vision model without changing the original upload."""
import base64
import io
import warnings

IMAGE_EXTENSIONS={'.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff'}

def prepare_image(path):
    from PIL import Image,ImageOps
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.width*image.height>16000000:raise ValueError('图片像素过大，请缩小后重试')
                image.seek(0)
                image=ImageOps.exif_transpose(image).convert('RGBA')
                background=Image.new('RGBA',image.size,'white');background.alpha_composite(image)
                image=background.convert('RGB');image.thumbnail((2048,2048))
                out=io.BytesIO();image.save(out,format='PNG')
                mime='image/png'
                if out.tell()>4*1024**2:
                    out=io.BytesIO();image.save(out,format='JPEG',quality=85);mime='image/jpeg'
                if out.tell()>5*1024**2:raise ValueError('图片处理后仍过大，请缩小后重试')
                part={'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+base64.b64encode(out.getvalue()).decode('ascii'),'detail':'auto'}}
                return part,{'image_width':image.width,'image_height':image.height,'image_analyzed':True}
    except (OSError,Image.DecompressionBombWarning,Image.DecompressionBombError):
        raise ValueError('图片无法读取或尺寸过大，请检查文件')
