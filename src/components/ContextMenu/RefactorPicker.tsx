import { ContextMenu } from "./ContextMenu";
import { useRefactorPickerStore } from "../../store/refactorPickerStore";

/** The choice between refactorings, when there's more than one. */
export function RefactorPicker() {
  const menu = useRefactorPickerStore((state) => state.menu);
  const close = useRefactorPickerStore((state) => state.close);
  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />;
}
