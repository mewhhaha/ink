export type ShooterProjectId = string & {
  readonly __brand: "ShooterProjectId";
};
export type ShooterRoomId = string & {
  readonly __brand: "ShooterRoomId";
};
export type ShooterCoverId = string & {
  readonly __brand: "ShooterCoverId";
};
export type ShooterSpawnId = string & {
  readonly __brand: "ShooterSpawnId";
};
export type ShooterWeaponId = string & {
  readonly __brand: "ShooterWeaponId";
};
export type ShooterEncounterId = string & {
  readonly __brand: "ShooterEncounterId";
};
export type ShooterDoorId = string & {
  readonly __brand: "ShooterDoorId";
};
export type ShooterObjectiveId = string & {
  readonly __brand: "ShooterObjectiveId";
};

export const shooter_project_id = identity<ShooterProjectId>("project");
export const shooter_room_id = identity<ShooterRoomId>("room");
export const shooter_cover_id = identity<ShooterCoverId>("cover");
export const shooter_spawn_id = identity<ShooterSpawnId>("spawn");
export const shooter_weapon_id = identity<ShooterWeaponId>("weapon");
export const shooter_encounter_id = identity<ShooterEncounterId>("encounter");
export const shooter_door_id = identity<ShooterDoorId>("door");
export const shooter_objective_id = identity<ShooterObjectiveId>("objective");

function identity<Identity extends string>(label: string) {
  return (source: string): Identity => {
    const value = source.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new Error(
        `shooter ${label} identity ${
          JSON.stringify(source)
        } must use lowercase kebab-case`,
      );
    }
    return value as Identity;
  };
}
