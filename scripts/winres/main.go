// Generate the original app icon and a non-elevated, DPI-aware Windows manifest.
package main

import (
	"github.com/tc-hib/winres"
	"log"
	"os"
)

func main() {
	in, err := os.Open(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	defer in.Close()
	icon, err := winres.LoadICO(in)
	if err != nil {
		log.Fatal(err)
	}
	rs := winres.ResourceSet{}
	if err = rs.SetIcon(winres.ID(1), icon); err != nil {
		log.Fatal(err)
	}
	rs.SetManifest(winres.AppManifest{Description: "交件箱", ExecutionLevel: winres.AsInvoker, DPIAwareness: winres.DPIPerMonitorV2, LongPathAware: true, Compatibility: winres.Win10AndAbove})
	out, err := os.Create(os.Args[2])
	if err != nil {
		log.Fatal(err)
	}
	defer out.Close()
	if err = rs.WriteObject(out, winres.ArchAMD64); err != nil {
		log.Fatal(err)
	}
}
