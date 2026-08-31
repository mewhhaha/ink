export type VehicleProjectId = string & {
  readonly __brand: "VehicleProjectId";
};
export type VehicleWaypointId = string & {
  readonly __brand: "VehicleWaypointId";
};
export type VehicleCheckpointId = string & {
  readonly __brand: "VehicleCheckpointId";
};
export type VehicleHazardId = string & {
  readonly __brand: "VehicleHazardId";
};
export type VehicleArchetypeId = string & {
  readonly __brand: "VehicleArchetypeId";
};
export type VehicleTargetId = string & {
  readonly __brand: "VehicleTargetId";
};

export const vehicle_project_id = identity<VehicleProjectId>("project");
export const vehicle_waypoint_id = identity<VehicleWaypointId>("waypoint");
export const vehicle_checkpoint_id = identity<VehicleCheckpointId>(
  "checkpoint",
);
export const vehicle_hazard_id = identity<VehicleHazardId>("hazard");
export const vehicle_archetype_id = identity<VehicleArchetypeId>(
  "archetype",
);
export const vehicle_target_id = identity<VehicleTargetId>("target");

function identity<Identity extends string>(label: string) {
  return (source: string): Identity => {
    const value = source.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new Error(
        `vehicle ${label} identity ${
          JSON.stringify(source)
        } must use lowercase kebab-case`,
      );
    }
    return value as Identity;
  };
}
