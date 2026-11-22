"""Generate Adobe-style splash screen (splash.png) and multi-size app icon (app.ico) for Toolbinhfile."""
import os
from PIL import Image, ImageDraw, ImageFont

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def load_font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def build_icon():
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Deep forest green rounded tile (#112A24) with emerald border (#146C53)
    draw.rounded_rectangle([12, 12, size - 12, size - 12], radius=52, fill=(17, 42, 36, 255), outline=(20, 108, 83, 255), width=8)
    # Inner emerald accent badge
    draw.rounded_rectangle([32, 32, size - 32, size - 32], radius=38, fill=(20, 108, 83, 255))

    font = load_font(112, bold=True)
    bbox = draw.textbbox((0, 0), "TB", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1] - 4), "TB", fill=(255, 255, 255, 255), font=font)

    ico_path = os.path.join(BASE_DIR, "app.ico")
    img.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"Generated {ico_path}")


def build_splash():
    w, h = 640, 360
    img = Image.new("RGB", (w, h), (17, 42, 36))
    draw = ImageDraw.Draw(img)

    # Subtle gradient background (deep forest green -> rich emerald dark)
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(13 + 12 * t)
        g = int(34 + 36 * t)
        b = int(29 + 26 * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    # Decorative geometric print-grid / crop-mark accents on right side
    accent_col = (34, 139, 108)
    for x in range(380, w - 20, 28):
        draw.line([(x, 24), (x, h - 24)], fill=(23, 62, 52), width=1)
    for y in range(24, h - 24, 28):
        draw.line([(380, y), (w - 20, y)], fill=(23, 62, 52), width=1)

    # Registration crop marks in 4 corners (Adobe / Prepress aesthetic)
    cm = (74, 222, 168)
    for cx, cy, dx, dy in [(22, 22, 1, 1), (w - 22, 22, -1, 1), (22, h - 22, 1, -1), (w - 22, h - 22, -1, -1)]:
        draw.line([(cx, cy), (cx + dx * 16, cy)], fill=cm, width=2)
        draw.line([(cx, cy), (cx, cy + dy * 16)], fill=cm, width=2)

    # Outer sleek border
    draw.rectangle([1, 1, w - 2, h - 2], outline=(26, 122, 94), width=2)

    # TB Logo Badge
    draw.rounded_rectangle([48, 66, 128, 146], radius=18, fill=(20, 108, 83), outline=(74, 222, 168), width=2)
    f_logo = load_font(42, bold=True)
    lb = draw.textbbox((0, 0), "TB", font=f_logo)
    draw.text((88 - (lb[2] - lb[0]) / 2 - lb[0], 106 - (lb[3] - lb[1]) / 2 - lb[1] - 2), "TB", fill=(255, 255, 255), font=f_logo)

    # Title & Subtitle
    f_title = load_font(34, bold=True)
    f_sub = load_font(15, bold=False)
    f_badge = load_font(12, bold=True)
    f_foot = load_font(13, bold=False)

    draw.text((148, 72), "Toolbinhfile Pro", fill=(255, 255, 255), font=f_title)
    draw.text((150, 118), "Prepress Imposition · CutContour 300 DPI · Dieline 3D", fill=(167, 243, 208), font=f_sub)

    # Feature pills
    pills = ["Bình Cắt Xén", "Bình Tem Bế", "Bình Sách 3D", "Bù Xén & Đường Cắt", "File Prep"]
    px, py = 48, 182
    for label in pills:
        tb = draw.textbbox((0, 0), label, font=f_badge)
        pw = (tb[2] - tb[0]) + 22
        draw.rounded_rectangle([px, py, px + pw, py + 26], radius=13, fill=(22, 66, 54), outline=(45, 150, 118), width=1)
        draw.text((px + 11, py + 5), label, fill=(209, 250, 229), font=f_badge)
        px += pw + 8

    # Progress bar track at bottom
    draw.rounded_rectangle([48, 286, w - 48, 294], radius=4, fill=(14, 48, 39))
    draw.rounded_rectangle([48, 286, 260, 294], radius=4, fill=(52, 211, 153))

    draw.text((48, 308), "Đang khởi tạo lõi xử lý PDF & giao diện làm việc Offline...", fill=(180, 228, 210), font=f_foot)
    draw.text((w - 150, 308), "Desktop Edition", fill=(110, 180, 155), font=f_foot)

    splash_path = os.path.join(BASE_DIR, "splash.png")
    img.save(splash_path, format="PNG")
    print(f"Generated {splash_path}")


if __name__ == "__main__":
    build_icon()
    build_splash()
