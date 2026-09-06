export default function UnsortedLayout({ children }: { children: React.ReactNode }) {
  // El camino documental necesita dos columnas anchas —el papel a la izquierda y
  // la propuesta con su asiento a la derecha—, así que no comparte el ancho de
  // lectura de las pantallas de una sola columna.
  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-4 p-4">{children}</div>
}
