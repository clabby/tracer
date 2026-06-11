# Production web image. buildx bake resolves relative paths (context,
# dockerfile) against the caller's cwd, not this file's location, so invoke
# from the repository root, e.g.:
#   docker buildx bake -f docker/docker-bake.hcl
# which is what `just build` does (it `cd ..`s first).
#
# The demo's loadgen image is built separately from docker/demo/docker-bake.hcl.

variable "REGISTRY" {
  default = "ghcr.io"
}

variable "REPOSITORY" {
  default = "clabby/tracer"
}

variable "DEFAULT_TAG" {
  default = "local"
}

variable "BUN_VERSION" {
  default = "1"
}

group "default" {
  targets = ["web"]
}

target "web" {
  context = "."
  dockerfile = "docker/Dockerfile.web"
  tags = [
    "tracer-web:${DEFAULT_TAG}",
    "${REGISTRY}/${REPOSITORY}-web:${DEFAULT_TAG}",
  ]
  args = {
    BUN_VERSION = BUN_VERSION
  }
}
