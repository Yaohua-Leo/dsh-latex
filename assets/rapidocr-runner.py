#!/usr/bin/env python3
"""Run RapidOCR on one image and emit one JSON object on stdout.

The Node side invokes this with an isolated interpreter (a managed venv) and
reads only the last JSON line, so package/model warmup banners on stderr never
break the protocol. The rapidocr_onnxruntime wheel bundles the PP-OCR ONNX
models; the first run initializes them.
"""
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - older embedded interpreters may not expose it
    pass


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: rapidocr-runner.py <image>"}))
        return 2
    image_path = sys.argv[1]
    try:
        from rapidocr_onnxruntime import RapidOCR

        engine = RapidOCR()
        result, _elapsed = engine(image_path)
        lines = []
        for item in result or []:
            if not isinstance(item, (list, tuple)) or len(item) < 3:
                continue
            box, text, score = item[0], item[1], item[2]
            points = []
            for point in box if isinstance(box, (list, tuple)) else []:
                if isinstance(point, (list, tuple)) and len(point) == 2:
                    points.append([round(float(point[0]), 2), round(float(point[1]), 2)])
            lines.append(
                {
                    "text": str(text),
                    "score": round(float(score), 6),
                    "box": points,
                }
            )
        text = "\n".join(item["text"] for item in lines if item["text"])
        print(json.dumps({"ok": True, "lines": lines, "text": text}, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - the Node side wants data, not a traceback
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
