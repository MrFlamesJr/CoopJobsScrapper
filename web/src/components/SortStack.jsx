import { useMemo } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import Dropdown from "./Dropdown.jsx";
import "./SortStack.css";

// field -> { label, asc, desc } direction captions shown on the toggle button.
const FIELDS = [
  { field: "employer", label: "Employer", asc: "A→Z", desc: "Z→A" },
  { field: "title", label: "Title", asc: "A→Z", desc: "Z→A" },
  { field: "location", label: "Location", asc: "A→Z", desc: "Z→A" },
  { field: "deadline", label: "Deadline", asc: "Soonest", desc: "Latest" },
  { field: "added", label: "Added", asc: "Oldest", desc: "Newest" },
  { field: "myrating", label: "My rating", asc: "Liked first", desc: "Disliked first" },
];
const FIELD_MAP = Object.fromEntries(FIELDS.map((f) => [f.field, f]));

// One source of truth for what counts as a sort field, so the URL parser in
// urlState.js can drop anything this list does not know about.
export const SORT_FIELD_NAMES = FIELDS.map((f) => f.field);

// Six dots in two columns, the usual "grip" affordance for a drag handle.
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="6" cy="3" r="1.2" />
      <circle cx="10" cy="3" r="1.2" />
      <circle cx="6" cy="8" r="1.2" />
      <circle cx="10" cy="8" r="1.2" />
      <circle cx="6" cy="13" r="1.2" />
      <circle cx="10" cy="13" r="1.2" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M5 5l6 6M11 5l-6 6" />
    </svg>
  );
}

/**
 * A single sortable row in the SortStack, using dnd-kit's useSortable hook.
 */
function SortableSortRow({ sort, meta, onToggleDir, onRemove, canRemove }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: sort.field });
  const dirLabel = sort.dir === "desc" ? meta.desc : meta.asc;

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`sort-stack__row ${isDragging ? "sort-stack__row--dragging" : ""}`}
      aria-label={`Reorder ${meta.label} sort: press space, then arrow keys, then space again`}
      {...attributes}
      {...listeners}
    >
      <span className="sort-stack__handle" aria-hidden="true">
        <GripIcon />
      </span>
      <span className="sort-stack__field">{meta.label}</span>
      {/* Prevent pointer events on action buttons from initiating a drag. */}
      <button
        type="button"
        className="sort-stack__dir"
        onClick={() => onToggleDir(sort.field)}
        title={`${meta.label}: sort ${sort.dir === "asc" ? "ascending" : "descending"} (click to flip)`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {dirLabel}
      </button>
      <button
        type="button"
        className="sort-stack__remove"
        onClick={() => onRemove(sort.field)}
        disabled={!canRemove}
        aria-label={`Remove ${meta.label} sort`}
        title={!canRemove ? "At least one sort is required" : `Remove ${meta.label} sort`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <CrossIcon />
      </button>
    </div>
  );
}

/**
 * A compact, reorderable stack of active sort keys. One ~26px row per active
 * field (drag handle, label, asc/desc toggle, remove ×), plus an
 * "+ Add sort" picker at the bottom for whatever fields aren't in use yet.
 * The whole thing lives inline in the sidebar — no popup — since that's the
 * only way it stays out of the way of everything below it.
 */
export default function SortStack({ sorts, onChange }) {
  const usedFields = new Set(sorts.map((s) => s.field));
  const availableFields = FIELDS.filter((f) => !usedFields.has(f.field));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const sortIds = useMemo(() => sorts.map((s) => s.field), [sorts]);

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return;

    const oldIndex = sorts.findIndex((s) => s.field === active.id);
    const newIndex = sorts.findIndex((s) => s.field === over.id);

    if (oldIndex !== -1 && newIndex !== -1) {
      onChange(arrayMove(sorts, oldIndex, newIndex));
    }
  }

  function toggleDir(field) {
    const next = sorts.map((s) =>
      s.field === field ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : s
    );
    onChange(next);
  }

  function removeRow(field) {
    if (sorts.length <= 1) return;
    onChange(sorts.filter((s) => s.field !== field));
  }

  function addField(field) {
    if (!field) return;
    onChange([...sorts, { field, dir: "asc" }]);
  }

  return (
    <div className="sort-stack">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
          {sorts.map((s) => {
            const meta = FIELD_MAP[s.field];
            if (!meta) return null;
            return (
              <SortableSortRow
                key={s.field}
                sort={s}
                meta={meta}
                onToggleDir={toggleDir}
                onRemove={removeRow}
                canRemove={sorts.length > 1}
              />
            );
          })}
        </SortableContext>
      </DndContext>

      {availableFields.length > 0 && (
        <Dropdown
          className="sort-stack__add"
          placeholder="+ Add sort"
          value=""
          options={availableFields.map((f) => ({ value: f.field, label: f.label }))}
          onChange={addField}
          ariaLabel="Add sort field"
        />
      )}
    </div>
  );
}
