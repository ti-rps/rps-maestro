import { cn } from "@/lib/cn";

// Table — extrai o markup idêntico das 5 tabelas (jobs/automations/schedules/
// users/xml): container com borda arredondada, thead cinza, divisórias no
// tbody, hover na linha, padding px-4 py-3 nas células. Colunas continuam
// definidas pelo caller; só o esqueleto é compartilhado.

export function Table({
  children,
  className,
  // stickyHeader: torna o wrapper interno um container de rolagem vertical
  // (maxHeight) pro <THead sticky> grudar no topo. Opt-in — as demais tabelas
  // não passam e seguem idênticas.
  stickyHeader = false,
  maxHeight = "70vh",
}: {
  children: React.ReactNode;
  className?: string;
  stickyHeader?: boolean;
  maxHeight?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900",
        className
      )}
    >
      {/* Wrapper interno rola na horizontal em telas estreitas; o externo
          mantém o clip dos cantos arredondados. min-w-[640px] força o scroll
          em vez de espremer as colunas no mobile. Com stickyHeader também rola
          na vertical, virando o contexto de sticky do cabeçalho. */}
      <div
        className={cn("overflow-x-auto", stickyHeader && "overflow-y-auto")}
        style={stickyHeader ? { maxHeight } : undefined}
      >
        <table className="w-full min-w-[640px] text-sm">{children}</table>
      </div>
    </div>
  );
}

export function THead({ children, sticky = false }: { children: React.ReactNode; sticky?: boolean }) {
  return (
    <thead className="bg-gray-50 dark:bg-gray-800">
      <tr
        className={cn(
          "text-left text-xs font-medium uppercase tracking-wider text-gray-500",
          // sticky no <tr> do thead + bg pra não vazar o conteúdo por baixo.
          sticky && "sticky top-0 z-10 bg-gray-50 dark:bg-gray-800"
        )}
      >
        {children}
      </tr>
    </thead>
  );
}

export function Th({
  children,
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn("px-4 py-3", className)} {...props}>
      {children}
    </th>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-gray-100 dark:divide-gray-800">{children}</tbody>;
}

export function Tr({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("hover:bg-gray-50 dark:hover:bg-gray-800", className)} {...props}>
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-4 py-3", className)} {...props}>
      {children}
    </td>
  );
}
