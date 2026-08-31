# @ink/scene

The stable scene contract is an immutable identity and hierarchy. Resolution
validates parent references and cycles, composes world transforms, and
propagates active state without introducing mutable renderer or authoring state.

Mutable scene authoring and serialization live under
`@ink/scene/experimental/*`. Applications compile editor documents into the
stable hierarchy instead of treating serialized scene files as runtime objects.
