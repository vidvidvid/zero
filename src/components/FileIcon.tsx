import { fileIcon } from "../lib/fileIcon";

export function FileIconSpan({ name }: { name: string }) {
  const icon = fileIcon(name);
  return (
    <span className="file-icon" style={{ color: icon.color }}>
      {icon.ch}
    </span>
  );
}
