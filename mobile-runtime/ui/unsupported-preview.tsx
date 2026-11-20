import type { ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function UnsupportedMobilePreviewCard({ format }: { format: string }): ReactNode {
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  return (
    <div
      data-testid="mobile-unsupported-preview"
      className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-2 p-6 text-center text-ui-base text-foreground-subtle"
    >
      <p className="font-medium text-foreground">
        {isZh ? `手机端暂不支持预览 ${format} 文件` : `${format} preview is not supported on mobile`}
      </p>
      <p className="text-ui-sm text-muted-foreground">
        {isZh ? "请在电脑端 ZCode 或使用系统应用查看。" : "Open it on desktop ZCode or with an external app."}
      </p>
    </div>
  );
}

export function PdfViewer() {
  return <UnsupportedMobilePreviewCard format="PDF" />;
}

export function PptxPreviewViewer() {
  return <UnsupportedMobilePreviewCard format="PPTX" />;
}

export function PreviewPaneOfficeXlsxContent() {
  return <UnsupportedMobilePreviewCard format="XLSX / 表格" />;
}

export function PreviewPaneOfficeDocxContent() {
  return <UnsupportedMobilePreviewCard format="DOCX" />;
}

export function PreviewPaneOfficeLegacyDocContent() {
  return <UnsupportedMobilePreviewCard format="DOC" />;
}
