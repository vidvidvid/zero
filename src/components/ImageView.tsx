import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { humanSize, imageType } from "../lib/imageFile";

/**
 * An image, where the editor would otherwise have shown you its bytes as text.
 *
 * Fit to the pane by default and 1:1 on click, which is the pair of sizes you
 * actually want — one to see the whole thing, one to see it truly. Anything
 * smaller than the pane is left alone, since scaling a 16px favicon up to fill
 * a window tells you nothing about it.
 */
export function ImageView({ absPath }: { absPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [actual, setActual] = useState(false);
  // a decode failure is the image's fault, not the read's, and it arrives on
  // the <img> rather than as a rejected promise
  const [broken, setBroken] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setBroken(false);
    setActual(false);

    api
      .readBinary(absPath)
      .then((buf) => {
        if (disposed) return;
        const type = imageType(absPath) ?? "application/octet-stream";
        const next = URL.createObjectURL(new Blob([buf], { type }));
        // the object URL pins the bytes in memory until it's revoked, so the
        // old one has to go the moment it stops being displayed
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setBytes(buf.byteLength);
        setUrl(next);
        setError(null);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });

    return () => {
      disposed = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [absPath]);

  if (error) return <div className="panel-error">{error}</div>;
  if (!url) return null;

  const meta = [
    size && `${size.w} × ${size.h}`,
    bytes ? humanSize(bytes) : null,
    (absPath.split(".").pop() ?? "").toUpperCase(),
  ].filter(Boolean);

  return (
    <div className="image-view">
      <div className={`image-stage ${actual ? "actual" : ""}`}>
        {broken ? (
          <div className="image-broken">
            this file has an image extension, but nothing here can decode it
          </div>
        ) : (
          <img
            src={url}
            alt=""
            className="image-canvas"
            onLoad={(e) => {
              const img = e.currentTarget;
              setSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setBroken(true)}
            onClick={() => setActual((v) => !v)}
            title={actual ? "click to fit" : "click for actual size"}
          />
        )}
      </div>
      {!broken && <div className="image-meta">{meta.join("  ·  ")}</div>}
    </div>
  );
}
