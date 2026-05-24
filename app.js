import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const { useCallback, useEffect, useMemo, useRef, useState } = React;
const e = React.createElement;
const BASE_RENDER_SCALE = 1.5;
const MIN_DRAG_SIZE = 8;
const HISTORY_LIMIT = 40;
const CUSTOM_PROPS = [
  "kind",
  "sourceId",
  "sourceText",
  "fontSizeHint",
  "pageNumber",
  "exportable",
  "linkedSourceId"
];

const TOOLS = [
  { id: "select", icon: "mouse-pointer-2", label: "Select" },
  { id: "text", icon: "type", label: "Text" },
  { id: "whiteout", icon: "eraser", label: "Whiteout" },
  { id: "highlight", icon: "highlighter", label: "Highlight" },
  { id: "draw", icon: "pencil", label: "Draw" },
  { id: "shape", icon: "square", label: "Shape" }
];

function cls(...values) {
  return values.filter(Boolean).join(" ");
}

function toPascalIconName(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function icon(name, className = "icon") {
  const iconName = toPascalIconName(name);
  const iconNode = window.lucide && (window.lucide.icons[iconName] || window.lucide[iconName]);
  if (!iconNode) {
    return e("span", { className, "aria-hidden": "true" });
  }

  return e(
    "svg",
    {
      className,
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
    iconNode.map(([tag, attrs], index) => e(tag, { key: index, ...attrs }))
  );
}

function ToolbarButton({ active, disabled, iconName, label, onClick, title, variant = "default" }) {
  return e(
    "button",
    {
      className: cls("toolbar-button", active && "is-active", variant !== "default" && `is-${variant}`),
      disabled,
      onClick,
      title: title || label,
      type: "button"
    },
    icon(iconName),
    e("span", null, label)
  );
}

function IconButton({ active, disabled, iconName, label, onClick, title, variant = "default" }) {
  return e(
    "button",
    {
      className: cls("icon-button", active && "is-active", variant !== "default" && `is-${variant}`),
      disabled,
      onClick,
      title: title || label,
      "aria-label": label,
      type: "button"
    },
    icon(iconName)
  );
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function drawVectorWhiteout(pdfPage, pageInfo, object) {
  const bounds = object.getBoundingRect(true, true);
  const scaleX = pdfPage.getWidth() / pageInfo.width;
  const scaleY = pdfPage.getHeight() / pageInfo.height;
  pdfPage.drawRectangle({
    x: bounds.left * scaleX,
    y: pdfPage.getHeight() - (bounds.top + bounds.height) * scaleY,
    width: bounds.width * scaleX,
    height: bounds.height * scaleY,
    color: PDFLib.rgb(1, 1, 1),
    borderWidth: 0
  });
}

function snapshotCanvas(canvas) {
  return JSON.stringify(canvas.toDatalessJSON(CUSTOM_PROPS));
}

function restoreCanvas(canvas, snapshot, afterRestore) {
  canvas.loadFromJSON(snapshot, () => {
    canvas.renderAll();
    afterRestore();
  });
}

function getTextBounds(textItem, viewport, styles) {
  if (!textItem.str || !textItem.str.trim()) return null;

  const transform = pdfjsLib.Util.transform(viewport.transform, textItem.transform);
  const style = styles[textItem.fontName] || {};
  const fontHeight = Math.hypot(transform[2], transform[3]);
  const ascent = typeof style.ascent === "number" ? style.ascent : 1;
  const left = transform[4];
  const top = transform[5] - fontHeight * ascent;
  const width = Math.max(textItem.width * viewport.scale, fontHeight * 0.6);
  const height = Math.max(fontHeight, 4);
  const angle = Math.atan2(transform[1], transform[0]) * (180 / Math.PI);

  return { left, top, width, height, angle };
}

function setCanvasTool(canvas, tool, color) {
  canvas.isDrawingMode = tool === "draw";
  canvas.selection = tool === "select";
  canvas.defaultCursor = tool === "text" ? "text" : tool === "draw" ? "crosshair" : "default";
  canvas.hoverCursor = tool === "text" ? "text" : "move";

  if (canvas.freeDrawingBrush) {
    canvas.freeDrawingBrush.color = color;
    canvas.freeDrawingBrush.width = 3;
  }

  canvas.forEachObject((object) => {
    if (object.kind === "existingText") {
      object.selectable = tool === "text" || tool === "whiteout";
      object.evented = tool === "text" || tool === "whiteout";
      object.hasControls = false;
      object.hasBorders = true;
      return;
    }

    const canSelect = tool === "select" || tool === "text";
    object.selectable = canSelect;
    object.evented = canSelect;
    object.hasControls = canSelect;
  });

  canvas.requestRenderAll();
}

function makeWhiteout(bounds, pageNumber, linkedSourceId) {
  return new fabric.Rect({
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    angle: bounds.angle || 0,
    fill: "#ffffff",
    stroke: "#ffffff",
    strokeWidth: 0,
    selectable: true,
    objectCaching: false,
    kind: "whiteout",
    pageNumber,
    linkedSourceId,
    exportable: true
  });
}

function setActiveObjectStyles(object, color, fontSize) {
  if (!object) return;
  if (object.type === "i-text" || object.type === "textbox") {
    object.set({ fill: color, fontSize });
  } else if (object.kind === "highlight") {
    object.set({ fill: color });
  } else if (object.kind === "shape") {
    object.set({ stroke: color });
  } else if (object.kind === "path") {
    object.set({ stroke: color });
  }
}

function canvasPointer(canvas, event) {
  return canvas.getPointer(event.e || event);
}

function bringEditableObjectsForward(canvas) {
  canvas.getObjects().forEach((object) => {
    if (object.kind !== "existingText") {
      object.bringToFront();
    }
  });
}

function editExistingText(canvas, target, options) {
  const bounds = target.getBoundingRect(true, true);
  const padding = 5;
  const sourceId = target.sourceId;
  const pageNumber = target.pageNumber;
  const whiteout = makeWhiteout(
    {
      left: bounds.left - padding,
      top: bounds.top - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2
    },
    pageNumber,
    sourceId
  );
  const fontSize = Math.max(target.fontSizeHint || options.fontSize, 8);
  const replacement = new fabric.IText(target.sourceText, {
    left: bounds.left,
    top: bounds.top - 1,
    fontFamily: "Arial",
    fontSize,
    fill: options.color,
    editable: true,
    objectCaching: false,
    lockUniScaling: false,
    kind: "textEdit",
    sourceId,
    pageNumber,
    exportable: true
  });

  target.set({ visible: false, evented: false, selectable: false });
  canvas.add(whiteout);
  canvas.add(replacement);
  bringEditableObjectsForward(canvas);
  canvas.setActiveObject(replacement);
  canvas.requestRenderAll();
  setTimeout(() => {
    replacement.enterEditing();
    replacement.selectAll();
  }, 0);
}

function deleteExistingText(canvas, target) {
  const bounds = target.getBoundingRect(true, true);
  const padding = 5;
  const whiteout = makeWhiteout(
    { left: bounds.left - padding, top: bounds.top - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 },
    target.pageNumber,
    target.sourceId
  );
  target.set({ visible: false, evented: false, selectable: false });
  canvas.add(whiteout);
  canvas.setActiveObject(whiteout);
  canvas.requestRenderAll();
}

function addTextbox(canvas, point, options) {
  const text = new fabric.IText("Type your text", {
    left: point.x,
    top: point.y,
    fontFamily: "Arial",
    fontSize: options.fontSize,
    fill: options.color,
    editable: true,
    objectCaching: false,
    lockUniScaling: false,
    kind: "text",
    pageNumber: options.pageNumber,
    exportable: true
  });
  canvas.add(text);
  canvas.setActiveObject(text);
  canvas.requestRenderAll();
  setTimeout(() => {
    text.enterEditing();
    text.selectAll();
  }, 0);
}

function addImageObject(canvas, src, bounds, options) {
  fabric.Image.fromURL(
    src,
    (imageObject) => {
      const naturalWidth = imageObject.width || 1;
      const naturalHeight = imageObject.height || 1;
      const width = Math.max(bounds.width, 24);
      const height = Math.max(bounds.height, 24);
      imageObject.set({
        left: bounds.left,
        top: bounds.top,
        scaleX: width / naturalWidth,
        scaleY: height / naturalHeight,
        cornerStyle: "circle",
        transparentCorners: false,
        objectCaching: false,
        kind: options.kind || "image",
        pageNumber: options.pageNumber,
        exportable: true
      });
      canvas.add(imageObject);
      canvas.setActiveObject(imageObject);
      canvas.requestRenderAll();
      options.onAdded();
    },
    { crossOrigin: "anonymous" }
  );
}

function selectionSummary(activeObject) {
  if (!activeObject) return null;
  if (activeObject.kind === "existingText") return { kind: "existingText", label: "Existing text" };
  if (activeObject.type === "activeSelection") return { kind: "multi", label: "Multiple objects" };
  if (activeObject.type === "i-text" || activeObject.type === "textbox") {
    return {
      kind: "text",
      label: activeObject.kind === "textEdit" ? "Edited text" : "Text",
      color: activeObject.fill,
      fontSize: Math.round(activeObject.fontSize || 16)
    };
  }
  if (activeObject.kind === "whiteout") return { kind: "whiteout", label: "Whiteout" };
  if (activeObject.kind === "highlight") return { kind: "highlight", label: "Highlight" };
  if (activeObject.kind === "shape") return { kind: "shape", label: "Shape" };
  if (activeObject.kind === "path") return { kind: "path", label: "Drawing" };
  if (activeObject.kind === "signature") return { kind: "signature", label: "Signature" };
  if (activeObject.kind === "image") return { kind: "image", label: "Image" };
  return { kind: "object", label: "Object" };
}

function UploadPanel({ onFile }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setDragging(false);
      const file = Array.from(event.dataTransfer.files || []).find((item) => item.type === "application/pdf");
      if (file) onFile(file);
    },
    [onFile]
  );

  return e(
    "main",
    {
      className: cls("upload-stage", dragging && "is-dragging"),
      onDragEnter: (event) => {
        event.preventDefault();
        setDragging(true);
      },
      onDragOver: (event) => event.preventDefault(),
      onDragLeave: () => setDragging(false),
      onDrop: handleDrop
    },
    e(
      "section",
      { className: "upload-panel" },
      e("div", { className: "brand-mark" }, icon("file-pen-line")),
      e("h1", null, "PDF Editor"),
      e("p", null, "Open a PDF, edit text and visual content on the page, then download the edited document."),
      e(
        "button",
        { className: "primary-upload", type: "button", onClick: () => inputRef.current.click() },
        icon("upload"),
        e("span", null, "Upload PDF file")
      ),
      e("input", {
        ref: inputRef,
        className: "visually-hidden",
        type: "file",
        accept: "application/pdf",
        onChange: (event) => {
          const file = event.target.files && event.target.files[0];
          if (file) onFile(file);
        }
      }),
      e("div", { className: "privacy-note" }, "Files stay in this browser session and are edited locally.")
    )
  );
}

function AppToolbar({
  activeSelection,
  canDownload,
  color,
  fileName,
  fontSize,
  hasDocument,
  onDelete,
  onDownload,
  onImageFile,
  onNewFile,
  onOpenSignature,
  onReplaceImageFile,
  onStyleChange,
  onUndo,
  onZoom,
  setColor,
  setFontSize,
  setTool,
  tool,
  zoom
}) {
  const imageRef = useRef(null);
  const replaceImageRef = useRef(null);
  const uploadRef = useRef(null);

  return e(
    "header",
    { className: "topbar" },
    e(
      "div",
      { className: "topbar-left" },
      e("button", { className: "app-logo", type: "button", onClick: () => uploadRef.current.click() }, icon("file-pen-line"), e("span", null, "PDF Editor")),
      hasDocument &&
        e(
          "div",
          { className: "file-pill", title: fileName },
          icon("file-text"),
          e("span", null, fileName || "Untitled PDF")
        )
    ),
    e(
      "div",
      { className: "tool-strip" },
      e("input", {
        ref: uploadRef,
        className: "visually-hidden",
        type: "file",
        accept: "application/pdf",
        onChange: (event) => {
          const file = event.target.files && event.target.files[0];
          if (file) onNewFile(file);
          event.target.value = "";
        }
      }),
      e("input", {
        ref: imageRef,
        className: "visually-hidden",
        type: "file",
        accept: "image/*",
        onChange: (event) => {
          const file = event.target.files && event.target.files[0];
          if (file) onImageFile(file);
          event.target.value = "";
        }
      }),
      e("input", {
        ref: replaceImageRef,
        className: "visually-hidden",
        type: "file",
        accept: "image/*",
        onChange: (event) => {
          const file = event.target.files && event.target.files[0];
          if (file) onReplaceImageFile(file);
          event.target.value = "";
        }
      }),
      e(ToolbarButton, { iconName: "upload", label: "Upload", onClick: () => uploadRef.current.click() }),
      hasDocument && TOOLS.map((item) =>
        e(ToolbarButton, {
          key: item.id,
          active: tool === item.id,
          disabled: !hasDocument,
          iconName: item.icon,
          label: item.label,
          onClick: () => setTool(item.id)
        })
      ),
      hasDocument &&
        e(ToolbarButton, {
          iconName: "image-plus",
          label: "Image",
          onClick: () => imageRef.current.click(),
          active: tool === "image"
        }),
      hasDocument &&
        e(ToolbarButton, {
          iconName: "replace",
          label: "Replace",
          onClick: () => replaceImageRef.current.click(),
          active: tool === "imageReplace"
        }),
      hasDocument &&
        e(ToolbarButton, {
          iconName: "signature",
          label: "Sign",
          onClick: onOpenSignature,
          active: tool === "sign"
        })
    ),
    e(
      "div",
      { className: "topbar-right" },
      hasDocument &&
        e(
          "label",
          { className: "compact-control", title: "Text and stroke color" },
          e("span", { className: "swatch-label" }, "Color"),
          e("input", {
            type: "color",
            value: color,
            onChange: (event) => {
              setColor(event.target.value);
              onStyleChange(event.target.value, fontSize);
            }
          })
        ),
      hasDocument &&
        e(
          "label",
          { className: "compact-control", title: "Text size" },
          e("span", null, "Size"),
          e("input", {
            className: "size-input",
            type: "number",
            min: "6",
            max: "120",
            value: fontSize,
            onChange: (event) => {
              const next = Math.max(6, Math.min(120, Number(event.target.value) || 16));
              setFontSize(next);
              onStyleChange(color, next);
            }
          })
        ),
      hasDocument && e("div", { className: "selection-pill" }, activeSelection ? activeSelection.label : "No selection"),
      hasDocument && e(IconButton, { iconName: "trash-2", label: "Delete selected", onClick: onDelete, disabled: !activeSelection }),
      hasDocument && e(IconButton, { iconName: "undo-2", label: "Undo", onClick: onUndo }),
      hasDocument && e(IconButton, { iconName: "zoom-out", label: "Zoom out", onClick: () => onZoom(-0.1), disabled: zoom <= 0.5 }),
      hasDocument && e("span", { className: "zoom-readout" }, `${Math.round(zoom * 100)}%`),
      hasDocument && e(IconButton, { iconName: "zoom-in", label: "Zoom in", onClick: () => onZoom(0.1), disabled: zoom >= 2.25 }),
      hasDocument &&
        e(ToolbarButton, {
          iconName: "download",
          label: "Download",
          onClick: onDownload,
          disabled: !canDownload,
          variant: "primary"
        })
    )
  );
}

function PageEditor({
  activeCanvasRef,
  color,
  fontSize,
  historyRef,
  onActiveSelection,
  onPageReady,
  pageInfo,
  pendingAsset,
  registerCanvas,
  setPendingAsset,
  setStatus,
  tool,
  zoom
}) {
  const pdfCanvasRef = useRef(null);
  const fabricCanvasRef = useRef(null);
  const fabricInstanceRef = useRef(null);
  const pageRef = useRef(null);
  const dragRef = useRef(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const fontSizeRef = useRef(fontSize);
  const pendingAssetRef = useRef(pendingAsset);

  useEffect(() => {
    toolRef.current = tool;
    colorRef.current = color;
    fontSizeRef.current = fontSize;
    pendingAssetRef.current = pendingAsset;
  }, [tool, color, fontSize, pendingAsset]);

  const pushHistory = useCallback(() => {
    const canvas = fabricInstanceRef.current;
    if (!canvas) return;
    const history = historyRef.current[pageInfo.pageNumber] || [];
    history.push(snapshotCanvas(canvas));
    if (history.length > HISTORY_LIMIT) history.shift();
    historyRef.current[pageInfo.pageNumber] = history;
  }, [historyRef, pageInfo.pageNumber]);

  useEffect(() => {
    let cancelled = false;
    const viewport = pageInfo.viewport;
    const pdfCanvas = pdfCanvasRef.current;
    const context = pdfCanvas.getContext("2d", { alpha: false });
    pdfCanvas.width = Math.round(pageInfo.width);
    pdfCanvas.height = Math.round(pageInfo.height);
    pdfCanvas.style.width = `${pageInfo.width}px`;
    pdfCanvas.style.height = `${pageInfo.height}px`;

    pageInfo.pdfPage
      .render({ canvasContext: context, viewport })
      .promise.then(() => {
        if (cancelled) return;

        const overlay = fabricCanvasRef.current;
        overlay.width = Math.round(pageInfo.width);
        overlay.height = Math.round(pageInfo.height);

        const canvas = new fabric.Canvas(overlay, {
          width: pageInfo.width,
          height: pageInfo.height,
          backgroundColor: "rgba(255,255,255,0)",
          enableRetinaScaling: false,
          preserveObjectStacking: true,
          selection: true,
          stopContextMenu: true
        });

        fabricInstanceRef.current = canvas;
        registerCanvas(pageInfo.pageNumber, canvas, pageRef.current);

        pageInfo.textItems.forEach((item, index) => {
          const bounds = getTextBounds(item, viewport, pageInfo.styles);
          if (!bounds) return;
          const sourceId = `p${pageInfo.pageNumber}-t${index}`;
          const hitbox = new fabric.Rect({
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            angle: bounds.angle,
            fill: "rgba(39, 127, 197, 0.001)",
            stroke: "rgba(39, 127, 197, 0)",
            strokeWidth: 1,
            selectable: tool === "text",
            evented: tool === "text",
            hasControls: false,
            hoverCursor: "text",
            objectCaching: false,
            kind: "existingText",
            sourceText: item.str,
            sourceId,
            fontSizeHint: Math.max(bounds.height * 0.82, 7),
            pageNumber: pageInfo.pageNumber,
            exportable: false
          });
          canvas.add(hitbox);
        });

        canvas.on("mouse:over", (event) => {
          const target = event.target;
          const activeTool = toolRef.current;
          if (target && target.kind === "existingText" && (activeTool === "text" || activeTool === "whiteout")) {
            target.set({ fill: "rgba(39, 127, 197, 0.14)", stroke: "rgba(39, 127, 197, 0.85)" });
            canvas.requestRenderAll();
          }
        });

        canvas.on("mouse:out", (event) => {
          const target = event.target;
          if (target && target.kind === "existingText" && canvas.getActiveObject() !== target) {
            target.set({ fill: "rgba(39, 127, 197, 0.001)", stroke: "rgba(39, 127, 197, 0)" });
            canvas.requestRenderAll();
          }
        });

        canvas.on("mouse:down", (event) => {
          activeCanvasRef.current = { canvas, pageNumber: pageInfo.pageNumber };
          const pointer = canvasPointer(canvas, event);
          const target = event.target;
          const activeTool = toolRef.current;
          const activeColor = colorRef.current;
          const activeFontSize = fontSizeRef.current;
          const activePendingAsset = pendingAssetRef.current;

          if (activeTool === "text") {
            if (target && target.kind === "existingText") {
              pushHistory();
              editExistingText(canvas, target, { color: activeColor, fontSize: activeFontSize });
              setStatus("Editing existing PDF text");
              return;
            }
            if (!target) {
              pushHistory();
              addTextbox(canvas, pointer, { color: activeColor, fontSize: activeFontSize, pageNumber: pageInfo.pageNumber });
              setStatus("Added editable text");
              return;
            }
          }

          if (activeTool === "whiteout" && target && target.kind === "existingText") {
            pushHistory();
            deleteExistingText(canvas, target);
            setStatus("Existing text deleted with whiteout");
            return;
          }

          if (activeTool === "whiteout" || activeTool === "highlight" || activeTool === "shape" || activeTool === "imageReplace") {
            if (activeTool === "imageReplace" && !activePendingAsset) {
              setStatus("Choose a replacement image first");
              return;
            }

            const fill =
              activeTool === "whiteout"
                ? "#ffffff"
                : activeTool === "highlight"
                  ? "rgba(255, 221, 76, 0.45)"
                  : activeTool === "shape"
                    ? "rgba(255,255,255,0)"
                    : "rgba(255,255,255,0.2)";
            const stroke = activeTool === "shape" ? activeColor : activeTool === "imageReplace" ? "#1f8a70" : fill;
            const rect = new fabric.Rect({
              left: pointer.x,
              top: pointer.y,
              width: 1,
              height: 1,
              fill,
              stroke,
              strokeWidth: tool === "shape" || tool === "imageReplace" ? 2 : 0,
              strokeDashArray: tool === "imageReplace" ? [6, 4] : null,
              selectable: false,
              evented: false,
              objectCaching: false,
              kind: activeTool === "whiteout" ? "whiteout" : activeTool === "highlight" ? "highlight" : "shape",
              pageNumber: pageInfo.pageNumber,
              exportable: true
            });
            canvas.add(rect);
            dragRef.current = { start: pointer, rect, tool: activeTool };
          }
        });

        canvas.on("mouse:move", (event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const pointer = canvasPointer(canvas, event);
          const left = Math.min(pointer.x, drag.start.x);
          const top = Math.min(pointer.y, drag.start.y);
          const width = Math.abs(pointer.x - drag.start.x);
          const height = Math.abs(pointer.y - drag.start.y);
          drag.rect.set({ left, top, width, height });
          canvas.requestRenderAll();
        });

        canvas.on("mouse:up", () => {
          const drag = dragRef.current;
          if (!drag) return;
          dragRef.current = null;
          const rect = drag.rect;
          const bounds = rect.getBoundingRect(true, true);
          const tooSmall = bounds.width < MIN_DRAG_SIZE || bounds.height < MIN_DRAG_SIZE;

          if (drag.tool === "imageReplace") {
            const activePendingAsset = pendingAssetRef.current;
            canvas.remove(rect);
            if (!activePendingAsset) {
              canvas.requestRenderAll();
              setStatus("Choose a replacement image first");
              return;
            }
            const imageBounds = tooSmall
              ? { left: drag.start.x, top: drag.start.y, width: 180, height: 120 }
              : { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
            pushHistory();
            canvas.add(makeWhiteout(imageBounds, pageInfo.pageNumber, `image-replace-${Date.now()}`));
            addImageObject(canvas, activePendingAsset.src, imageBounds, {
              kind: "image",
              pageNumber: pageInfo.pageNumber,
              onAdded: () => {
                setPendingAsset(null);
                setStatus("Replacement image placed");
              }
            });
            return;
          }

          if (tooSmall) {
            canvas.remove(rect);
            canvas.requestRenderAll();
            return;
          }

          rect.set({ selectable: true, evented: true });
          canvas.setActiveObject(rect);
          pushHistory();
          setStatus(drag.tool === "whiteout" ? "Whiteout added" : drag.tool === "highlight" ? "Highlight added" : "Shape added");
        });

        canvas.on("path:created", (event) => {
          if (event.path) {
            event.path.set({
              kind: "path",
              pageNumber: pageInfo.pageNumber,
              exportable: true,
              selectable: true,
              evented: true,
              objectCaching: false
            });
            pushHistory();
            setStatus("Drawing added");
          }
        });

        canvas.on("selection:created", (event) => {
          activeCanvasRef.current = { canvas, pageNumber: pageInfo.pageNumber };
          onActiveSelection(selectionSummary(event.selected && event.selected[0] ? event.selected[0] : canvas.getActiveObject()));
        });
        canvas.on("selection:updated", () => {
          activeCanvasRef.current = { canvas, pageNumber: pageInfo.pageNumber };
          onActiveSelection(selectionSummary(canvas.getActiveObject()));
        });
        canvas.on("selection:cleared", () => onActiveSelection(null));
        canvas.on("object:modified", () => pushHistory());
        canvas.on("text:editing:exited", () => pushHistory());

        historyRef.current[pageInfo.pageNumber] = [snapshotCanvas(canvas)];
        setCanvasTool(canvas, tool, color);
        onPageReady(pageInfo.pageNumber);
      });

    return () => {
      cancelled = true;
      const canvas = fabricInstanceRef.current;
      if (canvas) {
        canvas.dispose();
        fabricInstanceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const canvas = fabricInstanceRef.current;
    if (!canvas) return;
    setCanvasTool(canvas, tool, color);
  }, [tool, color]);

  useEffect(() => {
    const canvas = fabricInstanceRef.current;
    if (!canvas || !pendingAsset) return;
    if (pendingAsset.mode !== "image" && pendingAsset.mode !== "signature") return;

    const handler = (event) => {
      const target = event.target;
      if (target && pendingAsset.mode === "image") return;
      const pointer = canvasPointer(canvas, event);
      const width = pendingAsset.mode === "signature" ? 220 : 180;
      const height = pendingAsset.mode === "signature" ? 76 : 120;
      pushHistory();
      addImageObject(canvas, pendingAsset.src, { left: pointer.x, top: pointer.y, width, height }, {
        kind: pendingAsset.mode === "signature" ? "signature" : "image",
        pageNumber: pageInfo.pageNumber,
        onAdded: () => {
          setPendingAsset(null);
          setStatus(pendingAsset.mode === "signature" ? "Signature placed" : "Image placed");
        }
      });
      canvas.off("mouse:down", handler);
    };

    canvas.on("mouse:down", handler);
    return () => canvas.off("mouse:down", handler);
  }, [pendingAsset, pageInfo.pageNumber, pushHistory, setPendingAsset, setStatus]);

  return e(
    "section",
    {
      className: "page-shell",
      id: `page-${pageInfo.pageNumber}`,
      ref: pageRef,
      style: { width: `${pageInfo.width * zoom}px`, height: `${pageInfo.height * zoom}px` }
    },
    e(
      "div",
      {
        className: "page-surface",
        style: {
          width: `${pageInfo.width}px`,
          height: `${pageInfo.height}px`,
          transform: `scale(${zoom})`
        }
      },
      e("canvas", { ref: pdfCanvasRef, className: "pdf-canvas" }),
      e("canvas", { ref: fabricCanvasRef, className: "fabric-canvas" })
    ),
    e("div", { className: "page-number" }, `Page ${pageInfo.pageNumber}`)
  );
}

function SignatureDialog({ onClose, onSave }) {
  const [mode, setMode] = useState("draw");
  const [typedName, setTypedName] = useState("");
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const uploadRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
  }, [mode]);

  const pointer = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvasRef.current.width / rect.width),
      y: (event.clientY - rect.top) * (canvasRef.current.height / rect.height)
    };
  };

  const saveDrawn = () => {
    onSave(canvasRef.current.toDataURL("image/png"));
  };

  const saveTyped = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 680;
    canvas.height = 220;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111827";
    ctx.font = "76px Georgia, Times New Roman, serif";
    ctx.textBaseline = "middle";
    ctx.fillText(typedName || "Signature", 40, 110);
    onSave(canvas.toDataURL("image/png"));
  };

  return e(
    "div",
    { className: "modal-backdrop", role: "dialog", "aria-modal": "true" },
    e(
      "div",
      { className: "signature-modal" },
      e(
        "div",
        { className: "modal-header" },
        e("h2", null, "Create signature"),
        e(IconButton, { iconName: "x", label: "Close", onClick: onClose })
      ),
      e(
        "div",
        { className: "segmented" },
        ["draw", "type", "upload"].map((item) =>
          e(
            "button",
            {
              key: item,
              className: cls(mode === item && "is-active"),
              type: "button",
              onClick: () => setMode(item)
            },
            item[0].toUpperCase() + item.slice(1)
          )
        )
      ),
      mode === "draw" &&
        e(
          "div",
          { className: "signature-pad-wrap" },
          e("canvas", {
            ref: canvasRef,
            className: "signature-pad",
            width: 680,
            height: 220,
            onPointerDown: (event) => {
              drawingRef.current = true;
              const ctx = canvasRef.current.getContext("2d");
              const point = pointer(event);
              ctx.beginPath();
              ctx.moveTo(point.x, point.y);
            },
            onPointerMove: (event) => {
              if (!drawingRef.current) return;
              const ctx = canvasRef.current.getContext("2d");
              const point = pointer(event);
              ctx.lineTo(point.x, point.y);
              ctx.stroke();
            },
            onPointerUp: () => {
              drawingRef.current = false;
            },
            onPointerLeave: () => {
              drawingRef.current = false;
            }
          }),
          e(
            "div",
            { className: "modal-actions" },
            e("button", {
              className: "secondary-button",
              type: "button",
              onClick: () => {
                const ctx = canvasRef.current.getContext("2d");
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
              }
            }, "Clear"),
            e("button", { className: "primary-button", type: "button", onClick: saveDrawn }, "Save signature")
          )
        ),
      mode === "type" &&
        e(
          "div",
          { className: "typed-signature" },
          e("input", {
            value: typedName,
            placeholder: "Type your name",
            onChange: (event) => setTypedName(event.target.value)
          }),
          e("div", { className: "typed-preview" }, typedName || "Signature"),
          e(
            "div",
            { className: "modal-actions" },
            e("button", { className: "primary-button", type: "button", onClick: saveTyped }, "Save signature")
          )
        ),
      mode === "upload" &&
        e(
          "div",
          { className: "signature-upload" },
          e("input", {
            ref: uploadRef,
            className: "visually-hidden",
            type: "file",
            accept: "image/*",
            onChange: async (event) => {
              const file = event.target.files && event.target.files[0];
              if (file) onSave(await fileToDataUrl(file));
            }
          }),
          e(
            "button",
            { className: "primary-button", type: "button", onClick: () => uploadRef.current.click() },
            "Upload signature image"
          )
        )
    )
  );
}

function Sidebar({ pages, onJump, readyPages }) {
  return e(
    "aside",
    { className: "sidebar" },
    e("div", { className: "sidebar-title" }, "Pages"),
    e(
      "div",
      { className: "page-list" },
      pages.map((page) =>
        e(
          "button",
          {
            key: page.pageNumber,
            className: "page-chip",
            type: "button",
            onClick: () => onJump(page.pageNumber)
          },
          e("span", null, page.pageNumber),
          readyPages.has(page.pageNumber) ? icon("check", "tiny-icon") : icon("loader", "tiny-icon")
        )
      )
    )
  );
}

function App() {
  const [pages, setPages] = useState([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [tool, setTool] = useState("select");
  const [zoom, setZoom] = useState(1);
  const [color, setColor] = useState("#111827");
  const [fontSize, setFontSize] = useState(18);
  const [activeSelection, setActiveSelection] = useState(null);
  const [pendingAsset, setPendingAsset] = useState(null);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [readyPages, setReadyPages] = useState(() => new Set());
  const [downloadBusy, setDownloadBusy] = useState(false);

  const originalBytesRef = useRef(null);
  const canvasesRef = useRef({});
  const pageElementsRef = useRef({});
  const historyRef = useRef({});
  const activeCanvasRef = useRef(null);

  const registerCanvas = useCallback((pageNumber, canvas, element) => {
    canvasesRef.current[pageNumber] = canvas;
    pageElementsRef.current[pageNumber] = element;
  }, []);

  const loadPdf = useCallback(async (file) => {
    setLoading(true);
    setStatus("Loading PDF");
    setPages([]);
    setReadyPages(new Set());
    setActiveSelection(null);
    setPendingAsset(null);
    canvasesRef.current = {};
    pageElementsRef.current = {};
    historyRef.current = {};

    try {
      const buffer = await file.arrayBuffer();
      originalBytesRef.current = buffer.slice(0);
      const documentTask = pdfjsLib.getDocument({
        data: buffer,
        cMapUrl: "./vendor/pdfjs/cmaps/",
        standardFontDataUrl: "./vendor/pdfjs/standard_fonts/"
      });
      const pdf = await documentTask.promise;
      const loadedPages = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        setStatus(`Reading page ${pageNumber} of ${pdf.numPages}`);
        const pdfPage = await pdf.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: BASE_RENDER_SCALE });
        const textContent = await pdfPage.getTextContent();
        loadedPages.push({
          pageNumber,
          pdfPage,
          viewport,
          width: viewport.width,
          height: viewport.height,
          textItems: textContent.items,
          styles: textContent.styles || {}
        });
      }

      setFileName(file.name || "edited.pdf");
      setPages(loadedPages);
      setTool("select");
      setStatus("PDF ready");
    } catch (error) {
      console.error(error);
      setStatus("Could not open this PDF");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleImageFile = useCallback(async (file) => {
    const src = await fileToDataUrl(file);
    setPendingAsset({ mode: "image", src, name: file.name });
    setTool("image");
    setStatus("Click a page to place the image");
  }, []);

  const handleReplaceImageFile = useCallback(async (file) => {
    const src = await fileToDataUrl(file);
    setPendingAsset({ mode: "imageReplace", src, name: file.name });
    setTool("imageReplace");
    setStatus("Drag over the existing image or logo to replace it");
  }, []);

  const applyStyleToSelection = useCallback((nextColor, nextSize) => {
    const active = activeCanvasRef.current;
    if (!active || !active.canvas) return;
    const object = active.canvas.getActiveObject();
    if (!object) return;
    setActiveObjectStyles(object, nextColor, nextSize);
    active.canvas.requestRenderAll();
    setActiveSelection(selectionSummary(object));
  }, []);

  const deleteSelection = useCallback(() => {
    const active = activeCanvasRef.current;
    if (!active || !active.canvas) return;
    const canvas = active.canvas;
    const object = canvas.getActiveObject();
    if (!object) return;
    const history = historyRef.current[active.pageNumber] || [];
    history.push(snapshotCanvas(canvas));
    historyRef.current[active.pageNumber] = history;

    if (object.kind === "existingText") {
      deleteExistingText(canvas, object);
    } else if (object.type === "activeSelection") {
      object.forEachObject((item) => canvas.remove(item));
      canvas.discardActiveObject();
    } else {
      canvas.remove(object);
    }
    canvas.requestRenderAll();
    setActiveSelection(null);
    setStatus("Selection deleted");
  }, []);

  const undo = useCallback(() => {
    const active = activeCanvasRef.current;
    if (!active || !active.canvas) return;
    const history = historyRef.current[active.pageNumber] || [];
    if (history.length <= 1) {
      setStatus("No more changes to undo on this page");
      return;
    }
    history.pop();
    const previous = history[history.length - 1];
    restoreCanvas(active.canvas, previous, () => {
      setCanvasTool(active.canvas, tool, color);
      setActiveSelection(null);
      setStatus("Undo complete");
    });
  }, [color, tool]);

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const active = activeCanvasRef.current;
      const editing = active && active.canvas && active.canvas.getActiveObject() && active.canvas.getActiveObject().isEditing;
      if (editing) return;
      if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      deleteSelection();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deleteSelection]);

  const onPageReady = useCallback((pageNumber) => {
    setReadyPages((current) => {
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  const jumpToPage = useCallback((pageNumber) => {
    pageElementsRef.current[pageNumber] &&
      pageElementsRef.current[pageNumber].scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const exportPdf = useCallback(async () => {
    if (!originalBytesRef.current || !pages.length) return;
    setDownloadBusy(true);
    setStatus("Applying edits to PDF");

    try {
      const pdfDoc = await PDFLib.PDFDocument.load(originalBytesRef.current);
      const pdfPages = pdfDoc.getPages();

      for (const pageInfo of pages) {
        const canvas = canvasesRef.current[pageInfo.pageNumber];
        const pdfPage = pdfPages[pageInfo.pageNumber - 1];
        if (!canvas || !pdfPage) continue;

        const hiddenObjects = [];
        canvas.discardActiveObject();
        canvas.forEachObject((object) => {
          object.set({ borderColor: "transparent", cornerColor: "transparent" });
          if (object.kind === "whiteout") {
            drawVectorWhiteout(pdfPage, pageInfo, object);
          }
          if (object.kind === "existingText" || object.kind === "whiteout") {
            hiddenObjects.push({ object, visible: object.visible, evented: object.evented, selectable: object.selectable });
            object.set({ visible: false, evented: false, selectable: false });
          }
        });
        canvas.renderAll();

        const dataUrl = canvas.toDataURL({ format: "png", multiplier: 1, enableRetinaScaling: false });
        const imageBytes = dataUrlToUint8Array(dataUrl);
        const overlay = await pdfDoc.embedPng(imageBytes);
        pdfPage.drawImage(overlay, {
          x: 0,
          y: 0,
          width: pdfPage.getWidth(),
          height: pdfPage.getHeight()
        });

        hiddenObjects.forEach(({ object, visible, evented, selectable }) => {
          object.set({ visible, evented, selectable });
        });
        canvas.renderAll();
      }

      const bytes = await pdfDoc.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeName = fileName.replace(/\.pdf$/i, "") || "edited";
      link.href = url;
      link.download = `${safeName}-edited.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      setStatus("Edited PDF downloaded");
    } catch (error) {
      console.error(error);
      setStatus("Could not export the PDF");
    } finally {
      setDownloadBusy(false);
    }
  }, [fileName, pages]);

  const zoomBy = useCallback((delta) => {
    setZoom((current) => Math.max(0.5, Math.min(2.25, Number((current + delta).toFixed(2)))));
  }, []);

  const pageArea = useMemo(() => {
    if (!pages.length) return null;
    return e(
      "div",
      { className: "workspace" },
      e(Sidebar, { pages, onJump: jumpToPage, readyPages }),
      e(
        "main",
        { className: "document-scroll" },
        pages.map((page) =>
          e(PageEditor, {
            key: page.pageNumber,
            activeCanvasRef,
            color,
            fontSize,
            historyRef,
            onActiveSelection: setActiveSelection,
            onPageReady,
            pageInfo: page,
            pendingAsset,
            registerCanvas,
            setPendingAsset,
            setStatus,
            tool,
            zoom
          })
        )
      )
    );
  }, [color, fontSize, jumpToPage, onPageReady, pages, pendingAsset, readyPages, registerCanvas, tool, zoom]);

  return e(
    React.Fragment,
    null,
    e(AppToolbar, {
      activeSelection,
      canDownload: pages.length > 0 && readyPages.size === pages.length && !downloadBusy,
      color,
      fileName,
      fontSize,
      hasDocument: pages.length > 0,
      onDelete: deleteSelection,
      onDownload: exportPdf,
      onImageFile: handleImageFile,
      onNewFile: loadPdf,
      onOpenSignature: () => setSignatureOpen(true),
      onReplaceImageFile: handleReplaceImageFile,
      onStyleChange: applyStyleToSelection,
      onUndo: undo,
      onZoom: zoomBy,
      setColor,
      setFontSize,
      setTool,
      tool,
      zoom
    }),
    pages.length === 0 ? e(UploadPanel, { onFile: loadPdf }) : pageArea,
    e("footer", { className: "statusbar" }, e("span", null, loading ? "Working..." : status), pages.length > 0 && e("span", null, `${pages.length} page${pages.length === 1 ? "" : "s"}`)),
    signatureOpen &&
      e(SignatureDialog, {
        onClose: () => setSignatureOpen(false),
        onSave: (src) => {
          setPendingAsset({ mode: "signature", src, name: "signature" });
          setTool("sign");
          setSignatureOpen(false);
          setStatus("Click a page to place the signature");
        }
      })
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(e(App));
