// Monaco is the largest part of the UI, and most sessions browse tables without opening an
// editor, so it loads on first use (and in the background shortly after start, so that first
// use rarely waits).
import { lazy, Suspense, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { DiffEditor as DiffEditorType, Editor as EditorType } from "@monaco-editor/react";

const load = () => import("../monaco");
const LazyEditor = lazy(() => load().then((m) => ({ default: m.Editor })));
const LazyDiffEditor = lazy(() => load().then((m) => ({ default: m.DiffEditor })));

setTimeout(() => void load(), 3000);

function Loading() {
  const { t } = useTranslation();
  return <div className="empty">{t("common.loading")}</div>;
}

export function Editor(props: ComponentProps<typeof EditorType>) {
  return (
    <Suspense fallback={<Loading />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}

export function DiffEditor(props: ComponentProps<typeof DiffEditorType>) {
  return (
    <Suspense fallback={<Loading />}>
      <LazyDiffEditor {...props} />
    </Suspense>
  );
}
