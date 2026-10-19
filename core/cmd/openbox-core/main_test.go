package main

import (
	"reflect"
	"testing"
)

// Node 端(index.mjs / deploy.mjs)实际会调用的全部方法;缺一个面板就会在运行时报错。
var nodeMethods = []string{
	"hello",
	"normalizePolicy", "normalizeRouting", "routingFingerprint", "migrateStoredRouting",
	"classes", "forwardPlan", "entryPlan", "bypassPlan",
	"normalizeGroups", "builtinTags", "emitGroups",
	"configDetailed",
	"checkActivationCode", "activationState", "authorizationState",
}

func TestAllNodeMethodsRegistered(t *testing.T) {
	got := newRegistry().Methods()
	want := append([]string(nil), nodeMethods...)
	// 两边都排序后比较
	sortStrings(got)
	sortStrings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("方法清单不一致\n有: %v\n要: %v", got, want)
	}
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
