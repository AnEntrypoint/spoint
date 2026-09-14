---
key: mem-2cfd664bbb9f48fa-374
ns: default
created: 1789392854896
updated: 1789392854896
---

project/appruntime-vehicle-before-chassis-teardown: AppRuntime.destroyEntity must physics.removeVehicle(entity._vehicleId) BEFORE removeBody(_physicsBodyId): a Jolt VehicleConstraint holds a raw reference to its chassis body, so removing the body first leaves a dangling native ref and leaked the constraint+tester forever (found live on apps/vehicle destroy/editor delete).
