import { updateBoundElements } from "./binding";
import type { Bounds } from "./bounds";
import { getCommonBounds } from "./bounds";
import { mutateElement } from "./mutateElement";
import { getPerfectElementSize } from "./sizeHelpers";
import type { NonDeletedExcalidrawElement } from "./types";
import type {
  AppState,
  NormalizedZoomValue,
  NullableGridSize,
  PointerDownState,
} from "../types";
import { getBoundTextElement, getMinTextElementWidth } from "./textElement";
import type Scene from "../scene/Scene";
import {
  isArrowElement,
  isElbowArrow,
  isFrameLikeElement,
  isTextElement,
} from "./typeChecks";
import { getFontString } from "../utils";
import { TEXT_AUTOWRAP_THRESHOLD } from "../constants";
import { getGridPoint } from "../snapping";

export const dragSelectedElements = (
  pointerDownState: PointerDownState,
  _selectedElements: NonDeletedExcalidrawElement[],
  offset: { x: number; y: number },
  scene: Scene,
  snapOffset: {
    x: number;
    y: number;
  },
  gridSize: NullableGridSize,
) => {
  if (
    _selectedElements.length === 1 &&
    isElbowArrow(_selectedElements[0]) &&
    (_selectedElements[0].startBinding || _selectedElements[0].endBinding)
  ) {
    return;
  }

  const selectedElements = _selectedElements.filter(
    (el) => !(isElbowArrow(el) && el.startBinding && el.endBinding),
  );

  // we do not want a frame and its elements to be selected at the same time
  // but when it happens (due to some bug), we want to avoid updating element
  // in the frame twice, hence the use of set
  const elementsToUpdate = new Set<NonDeletedExcalidrawElement>(
    selectedElements,
  );
  const frames = selectedElements
    .filter((e) => isFrameLikeElement(e))
    .map((f) => f.id);

  if (frames.length > 0) {
    for (const element of scene.getNonDeletedElements()) {
      if (element.frameId !== null && frames.includes(element.frameId)) {
        elementsToUpdate.add(element);
      }
    }
  }

  const commonBounds = getCommonBounds(
    Array.from(elementsToUpdate).map(
      (el) => pointerDownState.originalElements.get(el.id) ?? el,
    ),
  );
  const adjustedOffset = calculateOffset(
    commonBounds,
    offset,
    snapOffset,
    gridSize,
  );

  elementsToUpdate.forEach((element) => {
    updateElementCoords(pointerDownState, element, adjustedOffset);
    if (
      // skip arrow labels since we calculate its position during render
      !isArrowElement(element)
    ) {
      const textElement = getBoundTextElement(
        element,
        scene.getNonDeletedElementsMap(),
      );
      if (textElement) {
        updateElementCoords(pointerDownState, textElement, adjustedOffset);
      }
    }
    updateBoundElements(element, scene.getElementsMapIncludingDeleted(), {
      simultaneouslyUpdated: Array.from(elementsToUpdate),
    });
  });
};

const calculateOffset = (
  commonBounds: Bounds,
  dragOffset: { x: number; y: number },
  snapOffset: { x: number; y: number },
  gridSize: NullableGridSize,
): { x: number; y: number } => {
  const [x, y] = commonBounds;
  let nextX = x + dragOffset.x + snapOffset.x;
  let nextY = y + dragOffset.y + snapOffset.y;

  if (snapOffset.x === 0 || snapOffset.y === 0) {
    const [nextGridX, nextGridY] = getGridPoint(
      x + dragOffset.x,
      y + dragOffset.y,
      gridSize,
    );

    if (snapOffset.x === 0) {
      nextX = nextGridX;
    }

    if (snapOffset.y === 0) {
      nextY = nextGridY;
    }
  }
  return {
    x: nextX - x,
    y: nextY - y,
  };
};

const updateElementCoords = (
  pointerDownState: PointerDownState,
  element: NonDeletedExcalidrawElement,
  dragOffset: { x: number; y: number },
) => {
  const originalElement =
    pointerDownState.originalElements.get(element.id) ?? element;

  const nextX = originalElement.x + dragOffset.x;
  const nextY = originalElement.y + dragOffset.y;

  mutateElement(element, {
    x: nextX,
    y: nextY,
  });
};

export const getDragOffsetXY = (
  selectedElements: NonDeletedExcalidrawElement[],
  x: number,
  y: number,
): [number, number] => {
  const [x1, y1] = getCommonBounds(selectedElements);
  return [x - x1, y - y1];
};

export const dragNewElement = ({
  newElement,
  elementType,
  originX,
  originY,
  x,
  y,
  width,
  height,
  shouldMaintainAspectRatio,
  shouldResizeFromCenter,
  zoom,
  widthAspectRatio = null,
  originOffset = null,
  informMutation = true,
}: {
  newElement: NonDeletedExcalidrawElement;
  elementType: AppState["activeTool"]["type"];
  originX: number;
  originY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  shouldMaintainAspectRatio: boolean;
  shouldResizeFromCenter: boolean;
  zoom: NormalizedZoomValue;
  /** whether to keep given aspect ratio when `isResizeWithSidesSameLength` is
      true */
  widthAspectRatio?: number | null;
  originOffset?: {
    x: number;
    y: number;
  } | null;
  informMutation?: boolean;
}) => {
  if (shouldMaintainAspectRatio && newElement.type !== "selection") {
    if (widthAspectRatio) {
      height = width / widthAspectRatio;
    } else {
      // Depending on where the cursor is at (x, y) relative to where the starting point is
      // (originX, originY), we use ONLY width or height to control size increase.
      // This allows the cursor to always "stick" to one of the sides of the bounding box.
      if (Math.abs(y - originY) > Math.abs(x - originX)) {
        ({ width, height } = getPerfectElementSize(
          elementType,
          height,
          x < originX ? -width : width,
        ));
      } else {
        ({ width, height } = getPerfectElementSize(
          elementType,
          width,
          y < originY ? -height : height,
        ));
      }

      if (height < 0) {
        height = -height;
      }
    }
  }

  let newX = x < originX ? originX - width : originX;
  let newY = y < originY ? originY - height : originY;

  if (shouldResizeFromCenter) {
    width += width;
    height += height;
    newX = originX - width / 2;
    newY = originY - height / 2;
  }

  let textAutoResize = null;

  if (isTextElement(newElement)) {
    height = newElement.height;
    const minWidth = getMinTextElementWidth(
      getFontString({
        fontSize: newElement.fontSize,
        fontFamily: newElement.fontFamily,
      }),
      newElement.lineHeight,
    );
    width = Math.max(width, minWidth);

    if (Math.abs(x - originX) > TEXT_AUTOWRAP_THRESHOLD / zoom) {
      textAutoResize = {
        autoResize: false,
      };
    }

    newY = originY;
    if (shouldResizeFromCenter) {
      newX = originX - width / 2;
    }
  }

  if (width !== 0 && height !== 0) {
    mutateElement(
      newElement,
      {
        x: newX + (originOffset?.x ?? 0),
        y: newY + (originOffset?.y ?? 0),
        width,
        height,
        ...textAutoResize,
      },
      informMutation,
    );
  }
};
