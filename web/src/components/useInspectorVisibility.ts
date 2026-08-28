import { useState } from "react";

const INSPECTOR_STORAGE_KEY = "cowork-inspector";

function readInspectorVisibility() {
  try {
    return globalThis.localStorage?.getItem(INSPECTOR_STORAGE_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

export function useInspectorVisibility() {
  const [inspectorVisible, setInspectorVisible] = useState(readInspectorVisibility);
  function toggleInspector() {
    setInspectorVisible((visible) => {
      const next = !visible;
      try {
        globalThis.localStorage?.setItem(INSPECTOR_STORAGE_KEY, next ? "visible" : "collapsed");
      } catch {
        // El inspector sigue funcionando aunque el almacenamiento no esté disponible.
      }
      return next;
    });
  }
  return { inspectorVisible, toggleInspector };
}
