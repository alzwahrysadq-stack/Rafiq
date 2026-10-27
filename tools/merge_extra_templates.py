"""يدمج templates_extra/*.html فوق app/src/main/assets/web/templates.js دون الحاجة إلى مجلد المرجع.

الاستعمال: python3 tools/merge_extra_templates.py
يُستعمل بعد تعديل أي قالب في templates_extra/. (build_web.py يفعل الشيء نفسه عند توفر المرجع.)
"""
import json
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(REPO, "app", "src", "main", "assets", "web")
EXTRA = os.path.join(REPO, "templates_extra")


def conv(src):
    src = re.sub(r"\{%\s*with\s+(\w+)\s*=\s*(.*?)\s*%\}", r"{% set \1 = \2 %}", src)
    src = re.sub(r"\{%\s*endwith\s*%\}", "", src)
    src = re.sub(r"([\w.]+)\[(\d*):(\d*)\]",
                 lambda m: "%s | slice(%s, %s)" % (m.group(1), m.group(2) or "0", m.group(3) or "999999"), src)
    return src.replace(" is none", " == null")


def main():
    path = os.path.join(WEB, "templates.js")
    text = open(path, encoding="utf-8").read()
    templates = json.loads(text[text.index("{"):text.rindex("}") + 1])
    for fn in sorted(os.listdir(EXTRA)):
        if fn.endswith(".html"):
            with open(os.path.join(EXTRA, fn), encoding="utf-8") as f:
                templates[fn] = conv(f.read())
    js = json.dumps(templates, ensure_ascii=False).replace("</", "<\\/")
    with open(path, "w", encoding="utf-8") as f:
        f.write("window.RAFIQ_TEMPLATES = " + js + ";\n")
    print("templates:", len(templates))


if __name__ == "__main__":
    main()
