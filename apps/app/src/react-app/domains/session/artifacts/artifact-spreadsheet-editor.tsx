/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { parseSpreadsheet, serializeSpreadsheet, type SpreadsheetRows } from "./artifact-spreadsheet-model";

type ArtifactSpreadsheetEditorProps = {
  name: string;
  text?: string;
  data?: ArrayBuffer;
  saving?: boolean;
  onSaveText: (content: string) => void | Promise<void>;
  onSaveBinary: (data: ArrayBuffer) => void | Promise<void>;
};

function cloneRows(rows: SpreadsheetRows): SpreadsheetRows {
  return rows.map((row) => [...row]);
}

function normalizeShape(rows: SpreadsheetRows): SpreadsheetRows {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

export function ArtifactSpreadsheetEditor(props: ArtifactSpreadsheetEditorProps) {
  const [rows, setRows] = useState<SpreadsheetRows>([[""]]);
  const [baseRows, setBaseRows] = useState<SpreadsheetRows>([[""]]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(baseRows), [baseRows, rows]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessage(null);
    parseSpreadsheet({ name: props.name, text: props.text, data: props.data })
      .then((parsed) => {
        if (cancelled) return;
        const shaped = normalizeShape(parsed);
        setRows(shaped);
        setBaseRows(cloneRows(shaped));
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Failed to parse spreadsheet");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [props.data, props.name, props.text]);

  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    setRows((current) => {
      const next = cloneRows(current);
      next[rowIndex] = [...(next[rowIndex] ?? [])];
      next[rowIndex][columnIndex] = value;
      return normalizeShape(next);
    });
  };

  const addRow = () => setRows((current) => [...current, Array.from({ length: Math.max(1, current[0]?.length ?? 1) }, () => "")]);
  const addColumn = () => setRows((current) => current.map((row) => [...row, ""]));
  const discard = () => setRows(cloneRows(baseRows));

  const save = async () => {
    setMessage(null);
    const serialized = await serializeSpreadsheet(props.name, rows);
    if (serialized.kind === "text") await props.onSaveText(serialized.content);
    else await props.onSaveBinary(serialized.data);
    setBaseRows(cloneRows(rows));
    setMessage("Saved");
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="xs" onClick={addRow}><Plus className="size-3" /> Row</Button>
        <Button variant="ghost" size="xs" onClick={addColumn}><Plus className="size-3" /> Column</Button>
        <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{message}</div>
        <Button variant="ghost" size="xs" onClick={discard} disabled={!dirty || props.saving}>Discard</Button>
        <Button variant="default" size="xs" onClick={() => void save()} disabled={!dirty || props.saving}>{props.saving ? "Saving" : "Save"}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex} className="border border-border p-0 align-top">
                    <input
                      className="h-8 w-full min-w-[120px] bg-transparent px-2 text-foreground outline-none focus:bg-muted/50"
                      value={cell}
                      onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
